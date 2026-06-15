/**
 * ── STELLAR SECTION ──────────────────────────────────────────────────────────
 * The Stellar PaymentDriver. Same PaymentDriver contract as EVM/Solana/TON;
 * classic Stellar assets (USDC/EURC) + native XLM underneath. The registry
 * auto-mounts this file (via the lazy loader in ../index.ts) the first time a
 * Stellar chain is used, so `@stellar/stellar-sdk` loads on demand — pure
 * EVM/Solana/TON installs never pull it in.
 *
 * Template A (memo-bound): the challenge nonce rides in a MEMO_HASH, and
 * verify() re-derives the watched account from the trusted `accept.payTo`
 * (never the client ref) — so a forged ref can't redirect verification and a
 * stranger's payment can't satisfy our challenge. Stellar is single-step final
 * (~5s, no reorgs), so confirm() just surfaces the settling ledger.
 */
import { Horizon, StrKey } from '@stellar/stellar-sdk'
import {
  STELLAR_MAINNET,
  STELLAR_DECIMALS,
  XLM_SYMBOL,
  stellarAssetId,
  parseStellarAssetId,
  type StellarPreset,
} from './chains.js'
import { parseUnits } from '../../util/units.js'
import { payStellar } from './pay.js'
import {
  verifyStellar,
  type StellarReader,
  type StellarTxRecord,
  type StellarPaymentRecord,
} from './verify.js'
import {
  assertStellarWallet,
  resolveStellarWallet,
  type StellarWalletConfig,
} from './wallet.js'
import {
  ConfirmationTimeoutError,
  UnknownTokenError,
  WrongFamilyError,
} from '../../errors.js'
import { rejectForeignToken } from '../shared.js'
import { nativeCost } from '../../util/cost.js'
import { delay } from '../../util/async.js'
import type {
  PaymentDriver,
  ResolvedNetwork,
  ResolveOptions,
  ResolvedToken,
  TokenInput,
  WalletBalance,
  WalletHandle,
} from '../types.js'

/** A Horizon balance line, loosely typed (the union differs per asset_type). */
type StellarBalanceLine = {
  asset_type: string
  balance?: string
  asset_code?: string
  asset_issuer?: string
}
/** Horizon 404s (account not created yet) vs a transient read failure. */
function isStellarNotFound(e: unknown): boolean {
  const x = e as { response?: { status?: number }; name?: string }
  return x?.response?.status === 404 || x?.name === 'NotFoundError'
}

export const stellarDriver: PaymentDriver = {
  family: 'stellar',
  resolve(opts: ResolveOptions): ResolvedNetwork | null {
    if (opts.chain !== 'stellar') return null
    const rpcUrl = opts.rpcUrl ?? STELLAR_MAINNET.defaultRpc
    return makeStellarNetwork(STELLAR_MAINNET, rpcUrl)
  },
}

function makeStellarNetwork(preset: StellarPreset, rpcUrl: string): ResolvedNetwork {
  // Horizon.Server throws synchronously on a non-https URL unless allowHttp is set.
  // Honour an explicit http:// endpoint (a local/internal/proxied Horizon) so a Stellar
  // client doesn't break the never-throw read-only contract just by being configured with one.
  const server = new Horizon.Server(rpcUrl, { allowHttp: rpcUrl.startsWith('http://') })
  const network = preset.caip2

  // Adapt the fluent Horizon API to the narrow reader the verifier needs, so
  // verify.ts stays unit-testable with a plain mock.
  const reader: StellarReader = {
    async transactionsForAccount(account, limit) {
      const page = await server
        .transactions()
        .forAccount(account)
        .order('desc')
        .limit(limit)
        .includeFailed(true)
        .call()
      return (page.records as unknown as StellarTxRecord[]).map((r) => ({
        hash: r.hash,
        successful: r.successful,
        memo: r.memo,
        memo_type: r.memo_type,
        created_at: r.created_at,
      }))
    },
    async paymentsForTransaction(txHash) {
      const page = await server.payments().forTransaction(txHash).limit(100).call()
      return (page.records as unknown as StellarPaymentRecord[])
        .filter((r) => r.type === 'payment')
        .map((r) => ({
          type: r.type,
          from: r.from,
          to: r.to,
          asset_type: r.asset_type,
          asset_code: r.asset_code,
          asset_issuer: r.asset_issuer,
          amount: r.amount,
        }))
    },
  }

  return {
    family: 'stellar',
    network,
    supports: (n) => n === network,

    resolveToken(token: TokenInput): ResolvedToken {
      if (token === 'native') {
        return { asset: 'native', decimals: STELLAR_DECIMALS, symbol: XLM_SYMBOL }
      }
      if (typeof token === 'string') {
        const info = preset.tokens[token.toUpperCase()]
        if (!info) {
          const known = Object.keys(preset.tokens).join(', ') || '(none built in)'
          throw new UnknownTokenError(
            `token "${token}" isn't built in for Stellar (known: ${known}). ` +
              `Pass { issuer, code, decimals } for a custom asset, or use 'native'.`
          )
        }
        return {
          asset: stellarAssetId(info.code, info.issuer),
          decimals: info.decimals,
          symbol: info.symbol,
        }
      }
      rejectForeignToken(token, 'stellar', network)
      // StellarToken { issuer, code, decimals, symbol? }
      const t = token as {
        issuer?: string
        code?: string
        decimals?: number
        symbol?: string
      }
      if (!t.issuer || !t.code || typeof t.decimals !== 'number') {
        throw new WrongFamilyError(
          `chain ${network} is Stellar; a custom token must be { issuer, code, decimals }.`
        )
      }
      return {
        asset: stellarAssetId(t.code, t.issuer),
        decimals: t.decimals,
        symbol: t.symbol ?? t.code,
      }
    },

    describeAsset(asset: string) {
      if (asset === 'native') return { symbol: XLM_SYMBOL, decimals: STELLAR_DECIMALS }
      for (const info of Object.values(preset.tokens)) {
        if (stellarAssetId(info.code, info.issuer) === asset) {
          return { symbol: info.symbol, decimals: info.decimals }
        }
      }
      return null
    },

    assertValidPayTo(payTo: string) {
      if (payTo.startsWith('0x')) {
        throw new WrongFamilyError(
          `chain ${network} is Stellar, but payTo "${payTo}" looks like an EVM address.`
        )
      }
      if (!StrKey.isValidEd25519PublicKey(payTo)) {
        throw new WrongFamilyError(
          `chain ${network} is Stellar, but payTo "${payTo}" is not a valid Stellar account (G…).`
        )
      }
    },

    bindWallet(wallet: unknown): WalletHandle {
      return { _native: assertStellarWallet(wallet, network) }
    },

    async send(wallet, accept) {
      const keypair = resolveStellarWallet(wallet._native as StellarWalletConfig)
      return payStellar({ server, keypair, accept })
    },

    async confirm(ref) {
      // Stellar is single-step final; once submitted the tx is in a ledger.
      // Fetch it to surface the ledger height (brief retry for propagation).
      for (let i = 0; i < 10; i += 1) {
        try {
          const tx = (await server.transactions().transaction(ref).call()) as unknown as {
            ledger_attr?: number
            ledger?: number
          }
          return { height: String(tx.ledger_attr ?? tx.ledger ?? 0) }
        } catch {
          await delay(1500)
        }
      }
      throw new ConfirmationTimeoutError(`Stellar tx ${ref} not visible on Horizon in time.`)
    },

    async estimateCost() {
      // Stellar's base fee is 100 stroops per operation (1 op here) = 0.00001 XLM.
      // Assets are 7dp (1 stroop = 1e-7 XLM).
      return nativeCost({
        symbol: XLM_SYMBOL,
        decimals: STELLAR_DECIMALS,
        fee: 100n,
        basis: 'heuristic',
        detail: 'base fee 100 stroops (1 operation)',
      })
    },

    async balanceOf(wallet: WalletHandle, asset: string): Promise<WalletBalance> {
      let owner: string
      try {
        owner = resolveStellarWallet(wallet._native as StellarWalletConfig).publicKey()
      } catch {
        return { token: null, native: null }
      }
      let lines: StellarBalanceLine[]
      try {
        const account = await server.loadAccount(owner)
        lines = account.balances as unknown as StellarBalanceLine[]
      } catch (e) {
        // 404 = the account doesn't exist yet → genuine zeroes; other error → unknown.
        return isStellarNotFound(e) ? { token: 0n, native: 0n } : { token: null, native: null }
      }
      const toBase = (s?: string): bigint => {
        try {
          return s != null ? parseUnits(s, STELLAR_DECIMALS) : 0n
        } catch {
          return 0n
        }
      }
      const native = toBase(lines.find((b) => b.asset_type === 'native')?.balance)
      if (asset === 'native') return { token: native, native }
      const parts = parseStellarAssetId(asset)
      const line = parts
        ? lines.find(
            (b) =>
              (b.asset_type === 'credit_alphanum4' || b.asset_type === 'credit_alphanum12') &&
              b.asset_code === parts.code &&
              b.asset_issuer === parts.issuer
          )
        : undefined
      return { token: toBase(line?.balance), native }
    },

    async recipientReady(payTo: string, asset: string) {
      let lines: StellarBalanceLine[]
      try {
        const account = await server.loadAccount(payTo)
        lines = account.balances as unknown as StellarBalanceLine[]
      } catch (e) {
        // Account doesn't exist → must be created (≥1 XLM reserve) before it can receive anything.
        if (isStellarNotFound(e)) return { ready: false as const, reason: 'INACTIVE' as const }
        return { ready: 'unknown' as const }
      }
      if (asset === 'native') return { ready: true as const } // account exists → can receive XLM
      const parts = parseStellarAssetId(asset)
      if (!parts) return { ready: 'unknown' as const }
      const hasTrustline = lines.some(
        (b) =>
          (b.asset_type === 'credit_alphanum4' || b.asset_type === 'credit_alphanum12') &&
          b.asset_code === parts.code &&
          b.asset_issuer === parts.issuer
      )
      return hasTrustline ? { ready: true as const } : { ready: false as const, reason: 'NO_TRUSTLINE' as const }
    },

    async verify(_ref, accept) {
      // Re-derive the watched account from the TRUSTED accept (payTo), not the
      // client ref — binding/provenance come from the memo + the payment op.
      return verifyStellar({ reader, accept })
    },
  }
}

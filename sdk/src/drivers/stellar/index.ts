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
  type StellarPreset,
} from './chains.js'
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
  WalletHandle,
} from '../types.js'

export const stellarDriver: PaymentDriver = {
  family: 'stellar',
  resolve(opts: ResolveOptions): ResolvedNetwork | null {
    if (opts.chain !== 'stellar') return null
    const rpcUrl = opts.rpcUrl ?? STELLAR_MAINNET.defaultRpc
    return makeStellarNetwork(STELLAR_MAINNET, rpcUrl)
  },
}

function makeStellarNetwork(preset: StellarPreset, rpcUrl: string): ResolvedNetwork {
  const server = new Horizon.Server(rpcUrl)
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

    async verify(_ref, accept) {
      // Re-derive the watched account from the TRUSTED accept (payTo), not the
      // client ref — binding/provenance come from the memo + the payment op.
      return verifyStellar({ reader, accept })
    },
  }
}

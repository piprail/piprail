/**
 * ── XRPL SECTION ──────────────────────────────────────────────────────────
 * The XRP Ledger PaymentDriver. Same PaymentDriver contract as EVM/Solana/TON/
 * Stellar; native XRP + issued currencies (USDC/RLUSD) underneath. The registry
 * auto-mounts this file (via the lazy loader in ../index.ts) the first time an
 * XRPL chain is used, so `xrpl` loads on demand — pure EVM/Solana/TON/Stellar
 * installs never pull it in.
 *
 * Template A (memo-bound): the challenge nonce rides in a Memo, and verify()
 * re-derives the watched account from the trusted `accept.payTo` (never the
 * client ref) — so a forged ref can't redirect verification and a stranger's
 * payment can't satisfy our challenge. XRPL is single-step final (~3–5s, no
 * reorgs), so confirm() just waits until the tx is validated.
 *
 * Network I/O is plain JSON-RPC over HTTPS (`fetch`) — no persistent WebSocket,
 * so the driver runs headless and in the browser. Signing is offline via the
 * xrpl.js Wallet.
 */
import { Wallet, isValidClassicAddress } from 'xrpl'
import {
  XRPL_MAINNET,
  XRP_DECIMALS,
  XRP_SYMBOL,
  xrplAssetId,
  type XrplPreset,
} from './chains.js'
import { payXrpl, type XrplPayClient } from './pay.js'
import { verifyXrpl, type XrplReader, type XrplTxRecord } from './verify.js'
import { assertXrplWallet, resolveXrplWallet, type XrplWalletConfig } from './wallet.js'
import {
  ConfirmationTimeoutError,
  UnknownTokenError,
  WrongFamilyError,
} from '../../errors.js'
import { rejectForeignToken } from '../shared.js'
import { nativeCost } from '../../util/cost.js'
import { floorUnits } from '../../util/units.js'
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

/** XRPL RPC reports a non-existent (unactivated) account as `actNotFound`. */
function isXrplActNotFound(e: unknown): boolean {
  return /actNotFound/i.test(String((e as Error)?.message ?? e))
}

export const xrplDriver: PaymentDriver = {
  family: 'xrpl',
  resolve(opts: ResolveOptions): ResolvedNetwork | null {
    if (opts.chain !== 'xrpl') return null
    const rpcUrl = opts.rpcUrl ?? XRPL_MAINNET.defaultRpc
    return makeXrplNetwork(XRPL_MAINNET, rpcUrl)
  },
}

function makeXrplNetwork(preset: XrplPreset, rpcUrl: string): ResolvedNetwork {
  const network = preset.caip2

  /** One JSON-RPC call. Throws on network/RPC error (verify catches → transient). */
  async function rpc<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method, params: [params] }),
    })
    if (!res.ok) throw new Error(`XRPL RPC ${method} HTTP ${res.status}`)
    const json = (await res.json()) as { result?: { status?: string; error?: string } & T }
    const result = json.result
    if (!result || result.status === 'error' || result.error) {
      throw new Error(`XRPL RPC ${method} error: ${result?.error ?? 'unknown'}`)
    }
    return result as T
  }

  // The JSON-RPC reads/writes the pay side needs.
  const payClient: XrplPayClient = {
    async accountSequence(account) {
      const r = await rpc<{ account_data: { Sequence: number } }>('account_info', {
        account,
        ledger_index: 'current',
      })
      return r.account_data.Sequence
    },
    async feeDrops() {
      const r = await rpc<{ drops: { open_ledger_fee: string } }>('fee', {})
      return r.drops.open_ledger_fee
    },
    async currentLedgerIndex() {
      const r = await rpc<{ ledger_current_index: number }>('ledger_current', {})
      return r.ledger_current_index
    },
    async submit(txBlob) {
      return rpc('submit', { tx_blob: txBlob })
    },
  }

  // Adapt account_tx to the narrow reader the verifier needs, handling both the
  // rippled (`tx`) and clio (`tx_json`) response shapes. Kept here so verify.ts
  // stays unit-testable with a plain mock.
  const reader: XrplReader = {
    async transactionsForAccount(account, limit) {
      const r = await rpc<{ transactions: unknown[] }>('account_tx', {
        account,
        ledger_index_min: -1,
        ledger_index_max: -1,
        forward: false,
        limit,
      })
      return r.transactions.map(mapAccountTxEntry)
    },
  }

  return {
    family: 'xrpl',
    network,
    supports: (n) => n === network,

    resolveToken(token: TokenInput): ResolvedToken {
      if (token === 'native') {
        return { asset: 'native', decimals: XRP_DECIMALS, symbol: XRP_SYMBOL }
      }
      if (typeof token === 'string') {
        const info = preset.tokens[token.toUpperCase()]
        if (!info) {
          const known = Object.keys(preset.tokens).join(', ') || '(none built in)'
          throw new UnknownTokenError(
            `token "${token}" isn't built in for XRPL (known: ${known}). ` +
              `Pass { issuer, currencyHex, decimals } for a custom IOU, or use 'native'.`
          )
        }
        return {
          asset: xrplAssetId(info.currencyHex, info.issuer),
          decimals: info.decimals,
          symbol: info.symbol,
        }
      }
      rejectForeignToken(token, 'xrpl', network)
      // XrplToken { issuer, currencyHex, decimals, symbol? }
      const t = token as {
        issuer?: string
        currencyHex?: string
        decimals?: number
        symbol?: string
      }
      if (!t.issuer || !t.currencyHex || typeof t.decimals !== 'number') {
        throw new WrongFamilyError(
          `chain ${network} is XRPL; a custom token must be { issuer, currencyHex, decimals }.`
        )
      }
      return {
        asset: xrplAssetId(t.currencyHex, t.issuer),
        decimals: t.decimals,
        symbol: t.symbol ?? t.currencyHex,
      }
    },

    describeAsset(asset: string) {
      if (asset === 'native') return { symbol: XRP_SYMBOL, decimals: XRP_DECIMALS }
      for (const info of Object.values(preset.tokens)) {
        if (xrplAssetId(info.currencyHex, info.issuer) === asset) {
          return { symbol: info.symbol, decimals: info.decimals }
        }
      }
      return null
    },

    assertValidPayTo(payTo: string) {
      if (payTo.startsWith('0x')) {
        throw new WrongFamilyError(
          `chain ${network} is XRPL, but payTo "${payTo}" looks like an EVM address.`
        )
      }
      if (!isValidClassicAddress(payTo)) {
        throw new WrongFamilyError(
          `chain ${network} is XRPL, but payTo "${payTo}" is not a valid XRPL account (r…).`
        )
      }
    },

    bindWallet(wallet: unknown): WalletHandle {
      return { _native: assertXrplWallet(wallet, network) }
    },

    async send(wallet, accept) {
      const w: Wallet = resolveXrplWallet(wallet._native as XrplWalletConfig)
      return payXrpl({ client: payClient, wallet: w, accept })
    },

    async confirm(ref) {
      // XRPL is single-step final; poll until the tx is validated, then surface
      // the ledger it landed in (brief retry for propagation).
      for (let i = 0; i < 12; i += 1) {
        try {
          const tx = await rpc<{ validated?: boolean; ledger_index?: number }>('tx', {
            transaction: ref,
          })
          if (tx.validated) return { height: String(tx.ledger_index ?? 0) }
        } catch {
          /* not visible yet — keep polling */
        }
        await delay(1500)
      }
      throw new ConfirmationTimeoutError(`XRPL tx ${ref} not validated on-ledger in time.`)
    },

    async estimateCost() {
      // XRPL's transaction cost is a tiny drops fee (~10–12 drops). XRP is 6dp.
      try {
        const drops = await payClient.feeDrops()
        const n = Number(drops)
        const fee = BigInt(Number.isFinite(n) && n > 12 ? Math.ceil(n) : 12)
        return nativeCost({
          symbol: XRP_SYMBOL,
          decimals: XRP_DECIMALS,
          fee,
          basis: 'estimated',
          detail: `network fee ${fee} drops`,
        })
      } catch {
        return nativeCost({
          symbol: XRP_SYMBOL,
          decimals: XRP_DECIMALS,
          fee: 12n,
          basis: 'heuristic',
          detail: '~12 drops (open-ledger fee unavailable)',
        })
      }
    },

    async balanceOf(wallet: WalletHandle, asset: string): Promise<WalletBalance> {
      let owner: string
      try {
        owner = resolveXrplWallet(wallet._native as XrplWalletConfig).classicAddress
      } catch {
        return { token: null, native: null }
      }
      let native: bigint | null = null
      try {
        const r = await rpc<{ account_data: { Balance: string } }>('account_info', {
          account: owner,
          ledger_index: 'validated',
        })
        native = BigInt(r.account_data.Balance) // drops = 6dp base units
      } catch (e) {
        native = isXrplActNotFound(e) ? 0n : null
      }
      if (asset === 'native') return { token: native, native }
      let token: bigint | null = null
      try {
        const [currencyHex, issuer] = asset.split(':')
        const r = await rpc<{ lines: { currency: string; account: string; balance: string }[] }>(
          'account_lines',
          { account: owner, ledger_index: 'validated' }
        )
        const line = r.lines.find(
          (l) => l.currency.toUpperCase() === (currencyHex ?? '').toUpperCase() && l.account === issuer
        )
        // IOU amounts use the driver's 6-dp scaling convention (USDC/RLUSD are 6dp). Use floorUnits
        // (truncate), NOT parseUnits — an XRPL issued-currency balance carries up to 15 significant
        // digits, and parseUnits THROWS on >6dp, which made a REAL funded trustline read as null.
        // floorUnits matches verify.ts (delivered_amount) so balanceOf and verify agree.
        token = line ? floorUnits(line.balance, XRP_DECIMALS) : 0n
      } catch (e) {
        token = isXrplActNotFound(e) ? 0n : null
      }
      return { token, native }
    },

    async recipientReady(payTo: string, asset: string) {
      try {
        await rpc('account_info', { account: payTo, ledger_index: 'validated' })
      } catch (e) {
        // Unactivated account → must hold ≥1 XRP base reserve before it can receive anything.
        if (isXrplActNotFound(e)) return { ready: false as const, reason: 'INACTIVE' as const }
        return { ready: 'unknown' as const }
      }
      if (asset === 'native') return { ready: true as const } // activated → can receive XRP
      try {
        const [currencyHex, issuer] = asset.split(':')
        const r = await rpc<{ lines: { currency: string; account: string }[] }>('account_lines', {
          account: payTo,
          ledger_index: 'validated',
        })
        const has = r.lines.some(
          (l) => l.currency.toUpperCase() === (currencyHex ?? '').toUpperCase() && l.account === issuer
        )
        return has ? { ready: true as const } : { ready: false as const, reason: 'NO_TRUSTLINE' as const }
      } catch {
        return { ready: 'unknown' as const }
      }
    },

    async verify(_ref, accept) {
      // Re-derive the watched account from the TRUSTED accept (payTo), not the
      // client ref — binding/provenance come from the Memo + the delivered amount.
      return verifyXrpl({ reader, accept })
    },
  }
}

/** Map one account_tx entry (rippled `tx` or clio `tx_json`) to an XrplTxRecord. */
function mapAccountTxEntry(entry: unknown): XrplTxRecord {
  const e = entry as {
    tx?: Record<string, unknown>
    tx_json?: Record<string, unknown>
    meta?: Record<string, unknown>
    metaData?: Record<string, unknown>
    validated?: boolean
    hash?: string
  }
  const t = e.tx_json ?? e.tx ?? {}
  const meta = e.meta ?? e.metaData ?? {}
  return {
    hash: (e.hash as string) ?? (t.hash as string) ?? '',
    validated: Boolean(e.validated),
    result: (meta.TransactionResult as string) ?? '',
    TransactionType: (t.TransactionType as string) ?? '',
    Account: (t.Account as string) ?? '',
    Destination: t.Destination as string | undefined,
    Memos: t.Memos as XrplTxRecord['Memos'],
    delivered_amount: (meta.delivered_amount ?? meta.DeliveredAmount) as
      | XrplTxRecord['delivered_amount'],
    date: typeof t.date === 'number' ? (t.date as number) : undefined,
  }
}

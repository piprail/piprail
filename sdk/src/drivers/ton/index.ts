/**
 * ── TON SECTION ──────────────────────────────────────────────────────────
 * The TON (Telegram Open Network) PaymentDriver. Same PaymentDriver contract
 * as EVM/Solana; jettons underneath. The registry auto-mounts this file (via
 * the lazy loader in ../index.ts) the first time a TON chain is used, so
 * `@ton/*` loads on demand — pure EVM/Solana installs never pull it in.
 *
 * USD₮ is built in (verified on-chain). Native USDC does NOT exist on TON, so
 * it's intentionally absent; pass a custom jetton via `{ master, decimals }`.
 *
 * Settlement on TON is async + message-based, so the proof ref is a self-
 * contained locator — `ton:<merchant-jetton-wallet>|<nonce>` — rather than a tx
 * hash: confirm() polls that account for the credit; verify() re-derives the
 * account from the trusted `accept` and reads the matching transfer. The nonce
 * rides in the transfer comment, so a TON proof is bound to its challenge.
 */
import { Address } from '@ton/core'
import { JettonMaster, TonClient } from '@ton/ton'
import { TON_MAINNET, TON_DECIMALS, type TonPreset } from './chains.js'
import { payTon } from './pay.js'
import { verifyTon, extractIncoming } from './verify.js'
import { assertTonWallet, resolveTonWallet, type TonWalletConfig } from './wallet.js'
import {
  ConfirmationTimeoutError,
  UnknownTokenError,
  WrongFamilyError,
  toInsufficientFundsError,
} from '../../errors.js'
import { rejectForeignToken } from '../shared.js'
import { nativeCost } from '../../util/cost.js'
import { delay } from '../../util/async.js'
import type { X402AcceptEntry } from '../../x402.js'
import type {
  PaymentDriver,
  ResolvedNetwork,
  ResolveOptions,
  ResolvedToken,
  TokenInput,
  WalletBalance,
  WalletHandle,
} from '../types.js'

export const tonDriver: PaymentDriver = {
  family: 'ton',
  resolve(opts: ResolveOptions): ResolvedNetwork | null {
    if (opts.chain !== 'ton') return null
    const rpcUrl = opts.rpcUrl ?? TON_MAINNET.defaultRpc
    return makeTonNetwork(TON_MAINNET, rpcUrl)
  },
}

function makeTonNetwork(preset: TonPreset, rpcUrl: string): ResolvedNetwork {
  const client = new TonClient({ endpoint: rpcUrl })
  const network = preset.caip2

  // Deriving a jetton wallet is a get-method call; cache it per (master, owner).
  const jwCache = new Map<string, Promise<Address>>()
  function jettonWalletFor(master: string, owner: string): Promise<Address> {
    const key = `${master}:${owner}`
    let p = jwCache.get(key)
    if (!p) {
      p = client
        .open(JettonMaster.create(Address.parse(master)))
        .getWalletAddress(Address.parse(owner))
      jwCache.set(key, p)
    }
    return p
  }

  // The account that receives the value: a jetton wallet, or `payTo` for native.
  function watchAccountFor(accept: X402AcceptEntry): Promise<Address> {
    return accept.asset === 'native'
      ? Promise.resolve(Address.parse(accept.payTo))
      : jettonWalletFor(accept.asset, accept.payTo)
  }

  return {
    family: 'ton',
    network,
    // Accept the canonical `tvm:-239` and the legacy `ton:-239` directly, so a
    // caller that bypasses `normalizeNetwork` and hands the raw legacy id to the
    // driver still matches. The normalizeNetwork alias is the canonical seam.
    supports: (n) => n === network || n === 'ton:-239',

    resolveToken(token: TokenInput): ResolvedToken {
      if (token === 'native') {
        return { asset: 'native', decimals: TON_DECIMALS, symbol: 'TON' }
      }
      if (typeof token === 'string') {
        const info = preset.tokens[token.toUpperCase()]
        if (!info) {
          const known = Object.keys(preset.tokens).join(', ') || '(none built in)'
          throw new UnknownTokenError(
            `token "${token}" isn't built in for TON (known: ${known}). ` +
              `Note: native USDC doesn't exist on TON. Pass { master, decimals } ` +
              `for a custom jetton, or use 'native'.`
          )
        }
        return { asset: info.master, decimals: info.decimals, symbol: info.symbol }
      }
      rejectForeignToken(token, 'ton', network)
      if (!('master' in token)) {
        throw new WrongFamilyError(
          `chain ${network} is TON; a custom token must be { master, decimals }.`
        )
      }
      return {
        asset: token.master,
        decimals: token.decimals,
        ...(token.symbol ? { symbol: token.symbol } : {}),
      }
    },

    describeAsset(asset: string) {
      if (asset === 'native') return { symbol: 'TON', decimals: TON_DECIMALS }
      for (const info of Object.values(preset.tokens)) {
        if (info.master === asset) return { symbol: info.symbol, decimals: info.decimals }
      }
      return null
    },

    assertValidPayTo(payTo: string) {
      if (payTo.startsWith('0x')) {
        throw new WrongFamilyError(
          `chain ${network} is TON, but payTo "${payTo}" looks like an EVM address.`
        )
      }
      try {
        Address.parse(payTo)
      } catch {
        throw new WrongFamilyError(
          `chain ${network} is TON, but payTo "${payTo}" is not a valid TON address.`
        )
      }
    },

    bindWallet(wallet: unknown): WalletHandle {
      return { _native: assertTonWallet(wallet, network) }
    },

    async send(wallet, accept) {
      try {
        const tw = await resolveTonWallet(wallet._native as TonWalletConfig)
        const senderJettonWallet =
          accept.asset === 'native'
            ? undefined
            : await jettonWalletFor(accept.asset, tw.contract.address.toString())
        await payTon({ client, wallet: tw, accept, senderJettonWallet })
        const watch = await watchAccountFor(accept)
        return encodeRef(watch, accept.extra.nonce)
      } catch (err) {
        // Surface "wallet can't afford it" as the same typed error as every
        // other family; anything else propagates unchanged.
        throw toInsufficientFundsError(err) ?? err
      }
    },

    async confirm(ref) {
      // Poll the watched account until the credit carrying our nonce appears.
      // TON has no N-confirmations counter; a committed tx is final enough.
      const { watch, nonce } = decodeRef(ref)
      const account = Address.parse(watch)
      for (let i = 0; i < 40; i += 1) {
        await delay(2500)
        let txs
        try {
          txs = await client.getTransactions(account, { limit: 16, archival: true })
        } catch {
          continue // transient RPC hiccup (e.g. rate limit) — keep waiting
        }
        for (const tx of txs) {
          const inc = extractIncoming(tx)
          if (inc && inc.comment === nonce) return { height: tx.lt.toString() }
        }
      }
      throw new ConfirmationTimeoutError(`TON payment for nonce ${nonce} did not settle in time.`)
    },

    async estimateCost(accept) {
      // Native ~0.01 TON network fee; a jetton transfer attaches ~0.05 TON for
      // gas + forwarding (leftover refunded). Nanoton = 9 decimals.
      const fee = accept.asset === 'native' ? 10_000_000n : 50_000_000n
      const detail =
        accept.asset === 'native'
          ? '~0.01 TON network fee'
          : '~0.05 TON attached for the jetton transfer (leftover refunded)'
      return nativeCost({ symbol: 'TON', decimals: TON_DECIMALS, fee, basis: 'heuristic', detail })
    },

    async balanceOf(wallet: WalletHandle, asset: string): Promise<WalletBalance> {
      let owner: string
      try {
        owner = (await resolveTonWallet(wallet._native as TonWalletConfig)).contract.address.toString()
      } catch {
        return { token: null, native: null }
      }
      const native = await client
        .getBalance(Address.parse(owner))
        .then((b) => BigInt(b))
        .catch(() => null)
      if (asset === 'native') return { token: native, native }
      let token: bigint | null
      try {
        const jw = await jettonWalletFor(asset, owner)
        const { stack } = await client.runMethod(jw, 'get_wallet_data')
        token = stack.readBigNumber()
      } catch {
        // Jetton wallet not deployed / read unavailable → unknown (never a false "broke").
        token = null
      }
      return { token, native }
    },

    // No receive prerequisite — the payer's gas auto-deploys the recipient's jetton wallet.
    async recipientReady() {
      return { ready: 'n/a' as const }
    },

    async verify(_ref, accept) {
      // Re-derive the watched account from the TRUSTED accept (not the ref), so
      // a forged ref can't redirect verification — provenance comes from the
      // official jetton master.
      const watch = await watchAccountFor(accept)
      return verifyTon({ client, watch, accept })
    },
  }
}

/** A self-contained proof locator: the watched account + the challenge nonce. */
function encodeRef(watch: Address, nonce: string): string {
  return `ton:${watch.toString()}|${nonce}`
}

function decodeRef(ref: string): { watch: string; nonce: string } {
  const body = ref.startsWith('ton:') ? ref.slice(4) : ref
  const i = body.indexOf('|')
  if (i < 0) throw new Error(`malformed TON proof ref: ${ref}`)
  return { watch: body.slice(0, i), nonce: body.slice(i + 1) }
}

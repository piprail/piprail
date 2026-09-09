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
import { Address, internal, SendMode } from '@ton/core'
import { JettonMaster, TonClient } from '@ton/ton'
import { TON_MAINNET, TON_DECIMALS, TON_NATIVE_SYMBOL, type TonPreset } from './chains.js'
import { payTon } from './pay.js'
import { verifyTon, extractIncoming } from './verify.js'
import { quoteTonSwap, swapTon } from './swap.js'
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
      // NEVER cache a REJECTED promise — a transient RPC blip would otherwise poison the cache
      // permanently and break verify/send/balanceOf for this (master, owner) forever. Self-evict
      // on failure so the next call retries (the resolved value is stable + safe to keep).
      p.catch(() => {
        if (jwCache.get(key) === p) jwCache.delete(key)
      })
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
        return { asset: 'native', decimals: TON_DECIMALS, symbol: TON_NATIVE_SYMBOL }
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
      if (asset === 'native') return { symbol: TON_NATIVE_SYMBOL, decimals: TON_DECIMALS }
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
          // confirm() is the payer's own liveness poll, NOT the security gate (verifyTon is) — so
          // detect a credit of EITHER kind carrying the nonce; verify enforces the asset-bound check.
          const inc = extractIncoming(tx, 'jetton') ?? extractIncoming(tx, 'native')
          if (inc && inc.comment === nonce) return { height: tx.lt.toString() }
        }
      }
      throw new ConfirmationTimeoutError(`TON payment for nonce ${nonce} did not settle in time.`)
    },

    async estimateCost(accept) {
      // Native ~0.01 GRAM network fee; a jetton transfer attaches ~0.05 GRAM for
      // gas + forwarding (leftover refunded). Nanoton = 9 decimals. (GRAM is the
      // native coin's post-2026-06-15 ticker; the network is still TON / tvm:-239.)
      const fee = accept.asset === 'native' ? 10_000_000n : 50_000_000n
      const detail =
        accept.asset === 'native'
          ? `~0.01 ${TON_NATIVE_SYMBOL} network fee`
          : `~0.05 ${TON_NATIVE_SYMBOL} attached for the jetton transfer (leftover refunded)`
      return nativeCost({ symbol: TON_NATIVE_SYMBOL, decimals: TON_DECIMALS, fee, basis: 'heuristic', detail })
    },

    /**
     * The bound wallet's own address — where THIS wallet gets paid. Derived from the key
     * material only: no RPC, nothing moved. See {@link ResolvedNetwork.addressOf}.
     *
     * 🔴 NON-BOUNCEABLE (`UQ…`), which is not the default `toString()` gives.
     *
     * TON encodes one account two ways. A bounceable `EQ…` address returns the funds to the
     * sender if the destination contract is not initialised, and a wallet contract is not
     * initialised until it has sent its first transaction. So a freshly generated agent wallet
     * advertising `EQ…` would have its FIRST payment bounce, which is exactly the payment a new
     * seller most needs to land. `UQ…` is also what every TON wallet shows you as your receive
     * address, so this matches what the operator sees and what the wallet file records.
     *
     * Verification is unaffected either way: `Address.parse` accepts both forms and they are the
     * same account.
     */
    async addressOf(wallet: WalletHandle): Promise<string> {
      const { contract } = await resolveTonWallet(wallet._native as TonWalletConfig)
      return contract.address.toString({ bounceable: false })
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

    /* ---- swap (OPTIONAL, opt-in): via STON.fi, keyless + no added fee. See ./swap.ts ---- */

    async quoteSwap({ from, to, wantAmount, slippageBps }) {
      return quoteTonSwap({ network, from, to, wantAmount, slippageBps })
    },

    async swap(wallet, quote) {
      const tw = await resolveTonWallet(wallet._native as TonWalletConfig)
      return swapTon({
        client,
        wallet: tw as never,
        quote,
        /*
         * TON settles asynchronously, so "sent" and "arrived" are different questions. This
         * waits for the WALLET's seqno to advance (its external message was accepted and
         * sent), then reports the resulting wallet transaction hash so the caller has a real,
         * checkable reference. Whether the ask side landed is a balance question, exactly as
         * it is on the payment path.
         */
        send: async ({ to, value, body }) => {
          const opened = client.open(tw.contract)
          const seqno = await opened.getSeqno()
          await opened.sendTransfer({
            seqno,
            secretKey: tw.keyPair.secretKey,
            sendMode: SendMode.PAY_GAS_SEPARATELY | SendMode.IGNORE_ERRORS,
            messages: [internal({ to: Address.parse(to), value, bounce: true, body: body as never })],
          })
          for (let i = 0; i < 30; i += 1) {
            await new Promise((r) => setTimeout(r, 2000))
            try {
              if ((await opened.getSeqno()) > seqno) break
            } catch {
              continue // a transient RPC hiccup must not be read as failure
            }
          }
          try {
            /*
             * 🔴 Take the transaction THIS WALLET INITIATED, not simply the newest one.
             *
             * A STON.fi swap refunds unused forward gas, and that refund arrives at this same
             * wallet within a second or two. Reading `limit: 1` therefore returned the REFUND
             * about half the time: a real transaction on the right account at the right moment,
             * but an incoming `excesses` message with no outgoing message at all. Anyone
             * following the reference saw an inbound transfer and no swap. (Caught by reading
             * a shipped proof back off the chain, not by any test — both recorded TON proofs
             * pointed at the refund leg.)
             *
             * A wallet's own sends are exactly its `external-in` transactions, and the seqno
             * has already advanced, so the newest one is ours.
             */
            const txs = await client.getTransactions(tw.contract.address, { limit: 10 })
            const mine = txs?.find((t) => t?.inMessage?.info?.type === 'external-in')
            const h = mine?.hash?.()
            if (h) return Buffer.from(h).toString('hex')
          } catch {
            /* fall through to the locator below */
          }
          // Honest fallback: name the wallet and the seqno rather than invent a hash.
          return `ton:${tw.contract.address.toString()}|seqno:${seqno}`
        },
      })
    },

    async verify(_ref, accept) {
      // Re-derive the watched account from the TRUSTED accept (not the ref), so
      // a forged ref can't redirect verification — provenance comes from the
      // official jetton master. Deriving a jetton wallet is a get-method RPC call, so guard it:
      // a transient failure must surface as a never-throw `tx_not_found` (retryable), per ERRORS.md
      // §5 — verify() must not throw on an RPC blip.
      let watch: Address
      try {
        watch = await watchAccountFor(accept)
      } catch {
        return { ok: false, error: 'tx_not_found', detail: `Could not derive/read the TON jetton wallet (transient RPC failure) — retry.` }
      }
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

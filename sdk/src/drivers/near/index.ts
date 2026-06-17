/**
 * ── NEAR SECTION ──────────────────────────────────────────────────────────
 * The NEAR PaymentDriver. Same PaymentDriver contract as the other families;
 * NEP-141 fungible tokens underneath. The registry auto-mounts this file (via
 * the lazy loader in ../index.ts) the first time a NEAR chain is used, so
 * `near-api-js` loads on demand — other installs never pull it in.
 *
 * Two payment modes:
 *   - **NEP-141 tokens** (USDC + USDT built in, both native, verified on-chain; or a
 *     custom `{ contractId, decimals }`): **Template A (memo-bound)**, verified BY HASH —
 *     the nonce rides in the `ft_transfer` memo and is re-checked in verify(). Needs a
 *     one-time NEP-145 `storage_deposit` on the recipient (gotcha below).
 *   - **Native NEAR** (`token: 'native'`, 24dp): **digest-bound** (like EVM/Solana/Sui) —
 *     a plain `Transfer`, verified by tx hash + a recency window + the gate's single-use set
 *     (no memo). Needs **no `storage_deposit`** and even creates a fresh implicit recipient —
 *     the zero-setup NEAR path. (NEAR is the volatile gas coin; pay in a token for stable pricing.)
 *
 * The proof ref is `<senderAccountId>:<txHash>` either way (NEAR's tx-status read needs the
 * sender to locate the tx — the sender is only a LOCATOR; every verified field comes from the
 * trusted `accept` + the on-chain receipt).
 *
 * **storage_deposit gotcha:** a NEP-141 recipient must be NEP-145-registered on the
 * token before it can receive, or `ft_transfer` panics (~0.00125 NEAR, one-time
 * per account+token). Merchants register `payTo` once, out of band. **Intents
 * trap:** never route this through NEAR Intents/solvers — that re-adds a
 * third-party facilitator; a plain ft_transfer + local verify is what we do.
 */
import { JsonRpcProvider, Account, actions } from 'near-api-js'
import { NEAR_MAINNET, NEAR_DECIMALS, isValidNearAccountId, type NearPreset } from './chains.js'
import { payNear, payNearNative, type NearSendClient } from './pay.js'
import { payExactNear, verifyAndSettleExactNear, type NearRelayClient } from './exact.js'
import { verifyNear, type NearReader, type NearReceiptView } from './verify.js'
import { assertNearWallet, resolveNearWallet, type NearWalletConfig } from './wallet.js'
import {
  ConfirmationTimeoutError,
  SettlementError,
  UnknownTokenError,
  WrongFamilyError,
} from '../../errors.js'
import { rejectForeignToken } from '../shared.js'
import { nativeCost } from '../../util/cost.js'
import type { X402ExactAcceptEntry } from '../../x402.js'
import type {
  PaymentDriver,
  ResolvedNetwork,
  ResolveOptions,
  ResolvedToken,
  TokenInput,
  WalletBalance,
  WalletHandle,
} from '../types.js'

export const nearDriver: PaymentDriver = {
  family: 'near',
  resolve(opts: ResolveOptions): ResolvedNetwork | null {
    if (opts.chain !== 'near') return null
    const rpcUrl = opts.rpcUrl ?? NEAR_MAINNET.defaultRpc
    return makeNearNetwork(NEAR_MAINNET, rpcUrl)
  },
}

function makeNearNetwork(preset: NearPreset, rpcUrl: string): ResolvedNetwork {
  const provider = new JsonRpcProvider({ url: rpcUrl })
  const network = preset.caip2

  // Adapt the tx-status read to the narrow reader the verifier needs, so
  // verify.ts stays unit-testable with a plain mock.
  const reader: NearReader = {
    async txStatus(hash, senderId) {
      const outcome = await provider.viewTransactionStatusWithReceipts({
        txHash: hash,
        accountId: senderId,
        waitUntil: 'EXECUTED_OPTIMISTIC',
      })
      if (!outcome) return null
      const status = outcome.status as { SuccessValue?: unknown; Failure?: unknown }
      const success =
        typeof status === 'object' && status !== null && 'SuccessValue' in status
      const receipts: NearReceiptView[] = (outcome.receipts_outcome ?? []).map((r) => ({
        executorId: r.outcome.executor_id,
        logs: r.outcome.logs ?? [],
      }))

      // Native-path fields (digest-bound NEAR): the tx's single receiver + summed Transfer
      // deposits, and the block timestamp for recency (native verify fails closed without it).
      const txn = (outcome as { transaction?: { receiver_id?: string; actions?: unknown[] } }).transaction
      const receiverId = txn?.receiver_id
      const nativeDeposit = sumTransferDeposits(txn?.actions).toString()
      let timestampMs: number | undefined
      try {
        const blockHash = (outcome as { transaction_outcome?: { block_hash?: string } }).transaction_outcome
          ?.block_hash
        if (blockHash) {
          const block = await provider.viewBlock({ blockId: blockHash })
          const header = (block as { header?: { timestamp_nanosec?: string; timestamp?: number } }).header
          // timestamp_nanosec is a string (the ns value exceeds JS safe-integer range).
          const ns = header?.timestamp_nanosec ?? (header?.timestamp != null ? String(header.timestamp) : undefined)
          if (ns != null) timestampMs = Number(BigInt(ns) / 1_000_000n) // ns → ms
        }
      } catch {
        /* block-time is best-effort (extra read); native verify fails closed if it's absent */
      }

      return { success, receipts, receiverId, nativeDeposit, timestampMs }
    },
  }

  return {
    family: 'near',
    network,
    supports: (n) => n === network,

    resolveToken(token: TokenInput): ResolvedToken {
      if (token === 'native') {
        // Native NEAR IS a payment asset (digest-bound, like EVM/Solana/Sui): a plain
        // Transfer, verified by tx hash + recency + single-use. No memo, no storage_deposit.
        return { asset: 'native', decimals: NEAR_DECIMALS, symbol: 'NEAR' }
      }
      if (typeof token === 'string') {
        const info = preset.tokens[token.toUpperCase()]
        if (!info) {
          const known = Object.keys(preset.tokens).join(', ') || '(none built in)'
          throw new UnknownTokenError(
            `token "${token}" isn't built in for NEAR (known: ${known}). ` +
              `Pass { contractId, decimals } for a custom NEP-141.`
          )
        }
        return { asset: info.contractId, decimals: info.decimals, symbol: info.symbol }
      }
      rejectForeignToken(token, 'near', network)
      const t = token as { contractId?: string; decimals?: number; symbol?: string }
      if (!t.contractId || typeof t.decimals !== 'number') {
        throw new WrongFamilyError(
          `chain ${network} is NEAR; a custom token must be { contractId, decimals }.`
        )
      }
      return {
        asset: t.contractId,
        decimals: t.decimals,
        ...(t.symbol ? { symbol: t.symbol } : {}),
      }
    },

    describeAsset(asset: string) {
      if (asset === 'native') return { symbol: 'NEAR', decimals: NEAR_DECIMALS }
      for (const info of Object.values(preset.tokens)) {
        if (info.contractId === asset) return { symbol: info.symbol, decimals: info.decimals }
      }
      return null
    },

    assertValidPayTo(payTo: string) {
      if (payTo.startsWith('0x')) {
        throw new WrongFamilyError(
          `chain ${network} is NEAR, but payTo "${payTo}" looks like an EVM/Sui 0x address.`
        )
      }
      if (!isValidNearAccountId(payTo)) {
        throw new WrongFamilyError(
          `chain ${network} is NEAR, but payTo "${payTo}" is not a valid NEAR account id.`
        )
      }
    },

    bindWallet(wallet: unknown): WalletHandle {
      return { _native: assertNearWallet(wallet, network) }
    },

    async send(wallet, accept) {
      const { accountId, signer } = resolveNearWallet(wallet._native as NearWalletConfig)
      const account = new Account(accountId, provider, signer)
      const hashOf = (outcome: unknown): string => {
        const hash = (outcome as { transaction?: { hash?: string } }).transaction?.hash
        if (!hash) throw new Error('NEAR: signAndSendTransaction returned no tx hash.')
        return hash
      }
      const client: NearSendClient = {
        async ftTransfer({ contractId, receiverId, amount, memo, gas, deposit }) {
          const outcome = await account.signAndSendTransaction({
            receiverId: contractId,
            actions: [
              actions.functionCall('ft_transfer', { receiver_id: receiverId, amount, memo }, gas, deposit),
            ],
          })
          return { hash: hashOf(outcome) }
        },
        async nativeTransfer({ receiverId, amount }) {
          // A plain Transfer action — no memo, no storage_deposit; creates a fresh implicit recipient.
          const outcome = await account.signAndSendTransaction({
            receiverId,
            actions: [actions.transfer(BigInt(amount))],
          })
          return { hash: hashOf(outcome) }
        },
      }
      const hash =
        accept.asset === 'native'
          ? await payNearNative({ client, accept })
          : await payNear({ client, accept })
      // The proof ref carries the sender so verify() can locate the tx.
      return encodeRef(accountId, hash)
    },

    async confirm(ref) {
      // send() already awaits execution (EXECUTED_OPTIMISTIC); re-check liveness.
      const { senderId, hash } = decodeRef(ref)
      try {
        const tx = await reader.txStatus(hash, senderId)
        if (tx && tx.success) return { height: '0' } // NEAR doesn't surface a numeric height here
      } catch {
        /* fall through */
      }
      throw new ConfirmationTimeoutError(`NEAR tx ${hash} not confirmed in time.`)
    },

    async estimateCost() {
      // An ft_transfer burns ~14 TGas; in NEAR (24dp) that's ≈0.0015 NEAR, plus the
      // mandatory 1 yoctoNEAR deposit (negligible). Tiny + roughly fixed.
      return nativeCost({
        symbol: 'NEAR',
        decimals: NEAR_DECIMALS,
        fee: 1_500_000_000_000_000_000_000n,
        basis: 'heuristic',
        detail: '~14 TGas for ft_transfer (≈0.0015 NEAR) + 1 yoctoNEAR deposit',
      })
    },

    async balanceOf(wallet: WalletHandle, asset: string): Promise<WalletBalance> {
      let accountId: string
      try {
        accountId = resolveNearWallet(wallet._native as NearWalletConfig).accountId
      } catch {
        return { token: null, native: null }
      }
      let native: bigint | null = null
      try {
        const r = (await provider.query({
          request_type: 'view_account',
          finality: 'final',
          account_id: accountId,
        })) as unknown as { amount?: string }
        native = r.amount != null ? BigInt(r.amount) : null
      } catch (e) {
        native = /does not exist|UNKNOWN_ACCOUNT/i.test(String((e as Error)?.message ?? e)) ? 0n : null
      }
      if (asset === 'native') return { token: native, native }
      let token: bigint | null = null
      try {
        const r = (await provider.query({
          request_type: 'call_function',
          finality: 'final',
          account_id: asset,
          method_name: 'ft_balance_of',
          args_base64: Buffer.from(JSON.stringify({ account_id: accountId })).toString('base64'),
        })) as unknown as { result?: number[] }
        token = r.result ? BigInt(JSON.parse(Buffer.from(r.result).toString())) : null
      } catch (e) {
        token = /does not exist|not registered|UNKNOWN_ACCOUNT/i.test(String((e as Error)?.message ?? e))
          ? 0n
          : null
      }
      return { token, native }
    },

    async recipientReady(payTo: string, asset: string) {
      // Native NEAR has no prerequisite (a Transfer even creates a fresh implicit account).
      if (asset === 'native') return { ready: 'n/a' as const }
      // NEP-141: payTo must be storage_deposit-registered (NEP-145) on the token. storage_balance_of
      // returns null when unregistered — distinct from a 0 balance (which ft_balance_of can't tell apart).
      try {
        const r = (await provider.query({
          request_type: 'call_function',
          finality: 'final',
          account_id: asset,
          method_name: 'storage_balance_of',
          args_base64: Buffer.from(JSON.stringify({ account_id: payTo })).toString('base64'),
        })) as unknown as { result?: number[] }
        const parsed = r.result ? JSON.parse(Buffer.from(r.result).toString()) : null
        return parsed == null
          ? { ready: false as const, reason: 'NOT_REGISTERED' as const }
          : { ready: true as const }
      } catch {
        return { ready: 'unknown' as const }
      }
    },

    async verify(ref, accept) {
      const { senderId, hash } = decodeRef(ref)
      return verifyNear({ reader, hash, senderId, accept })
    },

    // Standard x402 `exact` rail, BUYER side — build a NEP-366 SignedDelegateAction authorizing one
    // NEP-141 ft_transfer (per scheme_exact_near.md). The buyer signs with its FULL-ACCESS key and
    // spends ZERO NEAR; a keyless facilitator's relayer prepays the gas + 1 yoctoNEAR and submits.
    // NEAR exact is NEP-141-only + facilitator-settled (see ./exact.ts for why) — native NEAR isn't
    // exact-payable. Pre-reads the access-key nonce + final block height, then defers to payExactNear.
    async payExact(wallet: WalletHandle, accept: X402ExactAcceptEntry) {
      const { accountId, signer } = resolveNearWallet(wallet._native as NearWalletConfig)
      const publicKey = await signer.getPublicKey()
      const [accessKey, block] = await Promise.all([
        provider.query({
          request_type: 'view_access_key',
          finality: 'final',
          account_id: accountId,
          public_key: publicKey.toString(),
        }) as Promise<{ nonce?: number | string | bigint }>,
        provider.viewBlock({ finality: 'final' }) as Promise<{ header?: { height?: number | string } }>,
      ])
      const accessKeyNonce = BigInt(accessKey.nonce ?? 0)
      const blockHeight = BigInt(block.header?.height ?? 0)
      const { payload, payerFrom, nonce } = await payExactNear({
        signer,
        senderId: accountId,
        blockHeight,
        accessKeyNonce,
        accept,
      })
      return { payload, accepted: accept, payerFrom, nonce }
    },

    // The gate's rail-advertisement SPI. NEAR exact is NEP-141-only. The fee payer (the relayer that
    // prepays gas + the 1 yocto, so the BUYER pays nothing) comes from EITHER the merchant's own bound
    // `relayer` (SELF mode — what works today) OR a facilitator-provided `feePayer` (facilitator mode —
    // for when a NEAR x402 facilitator ships; none does yet). `null` for native / non-NEP-141 / when no
    // fee payer is available. The buyer's SignedDelegateAction is self-contained, so `feePayer` rides in
    // `extra` only for observability + (future) facilitator forwarding.
    async resolveExactRail({ asset, relayer, feePayer }) {
      if (asset === 'native' || !isValidNearAccountId(asset)) return null
      let fp = feePayer
      if (!fp && relayer) {
        try {
          fp = resolveNearWallet(relayer._native as NearWalletConfig).accountId
        } catch {
          return null // a malformed relayer wallet can't carry a rail
        }
      }
      if (!fp) return null
      return { method: 'near' as const, extra: { feePayer: fp } }
    },

    // Standard x402 `exact` rail, SELLER side (SELF-SETTLE) — decode + verify the inbound delegate
    // against the trusted accept, then RELAY it from the merchant's own NEAR relayer (which prepays the
    // sub-cent gas + the 1 yocto). The buyer stays gasless. THIS is how a NEAR gate gets paid today
    // (no third-party facilitator settles NEAR yet). The drain guard (gas/deposit caps) lives in
    // verifyAndSettleExactNear, invisible to the gate.
    async settleExactSelf({ relayer, payload, accept }) {
      if (!('signedDelegateAction' in payload)) {
        // A non-NEAR payload reached the NEAR driver — impossible via per-spec routing; fail closed.
        return { ok: false, error: 'signature_invalid', detail: 'NEAR exact expects a { signedDelegateAction } payload.' }
      }
      let relayerWallet: ReturnType<typeof resolveNearWallet>
      try {
        relayerWallet = resolveNearWallet(relayer._native as NearWalletConfig)
      } catch (err) {
        throw new SettlementError(
          `NEAR exact settle: the relayer wallet is invalid (${err instanceof Error ? err.message : String(err)}).`,
          { cause: err }
        )
      }
      const relayerAccount = new Account(relayerWallet.accountId, provider, relayerWallet.signer)
      const isSuccess = (s: unknown): boolean =>
        typeof s === 'object' && s !== null && 'SuccessValue' in (s as Record<string, unknown>)

      const client: NearRelayClient = {
        async currentBlockHeight() {
          try {
            const b = (await provider.viewBlock({ finality: 'final' })) as { header?: { height?: number | string } }
            return b.header?.height != null ? BigInt(b.header.height) : null
          } catch {
            return null
          }
        },
        async relay({ senderId, delegateAction, signature }) {
          const outcome = (await relayerAccount.signAndSendTransaction({
            receiverId: senderId,
            actions: [actions.signedDelegate({ delegateAction, signature: signature as never })],
            waitUntil: 'FINAL',
          })) as {
            transaction?: { hash?: string }
            status?: unknown
            receipts_outcome?: Array<{ outcome?: { executor_id?: string; status?: unknown } }>
          }
          const txHash = outcome.transaction?.hash ?? ''
          // Inner success = the TOKEN-CONTRACT receipt itself succeeded (an outer-tx success with a
          // failed inner ft_transfer must NOT count — NEAR runs the transfer in a spawned receipt).
          const tokenReceipt = (outcome.receipts_outcome ?? []).find((r) => r.outcome?.executor_id === accept.asset)
          const innerSuccess = tokenReceipt ? isSuccess(tokenReceipt.outcome?.status) : isSuccess(outcome.status)
          return { txHash, innerSuccess }
        },
      }
      return verifyAndSettleExactNear({ client, payload, accept })
    },
  }
}

/** Proof ref `<senderAccountId>:<txHash>` — sender lets verify() locate the tx. */
function encodeRef(accountId: string, hash: string): string {
  return `${accountId}:${hash}`
}

function decodeRef(ref: string): { senderId: string; hash: string } {
  const i = ref.indexOf(':')
  if (i < 0) return { senderId: '', hash: ref }
  return { senderId: ref.slice(0, i), hash: ref.slice(i + 1) }
}

/** Sum the yoctoNEAR `deposit` of every Transfer action in a tx's action list (RPC JSON form
 *  `{ Transfer: { deposit } }`; tolerant of a lowercase `transfer` variant). For the native path. */
function sumTransferDeposits(actions: unknown[] | undefined): bigint {
  if (!Array.isArray(actions)) return 0n
  let sum = 0n
  for (const a of actions) {
    const t =
      (a as { Transfer?: { deposit?: string | number } }).Transfer ??
      (a as { transfer?: { deposit?: string | number } }).transfer
    if (t && t.deposit != null) {
      try {
        sum += BigInt(t.deposit)
      } catch {
        /* skip a malformed deposit */
      }
    }
  }
  return sum
}

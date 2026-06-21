/**
 * x402-over-A2A — the SELLER-side transport adapter for the Agent2Agent (A2A) protocol.
 *
 * A2A is an open protocol (created by Google, now a Linux Foundation project — a2a-protocol.org;
 * official JS runtime `@a2a-js/sdk` from the `a2aproject` org). It is x402's third official transport
 * (alongside HTTP and MCP). It carries PipRail's
 * BYTE-IDENTICAL `PaymentRequired`/`PaymentPayload`/`SettlementResponse` envelopes inside
 * A2A `Task`/`Message` JSON-RPC `metadata` (five namespaced `x402.payment.*` keys) keyed
 * off a coarse A2A Task state — instead of base64 HTTP headers. It is a thin codec + adapter
 * ABOVE the `PaymentDriver` boundary: ZERO driver changes, ZERO scheme changes, ZERO chain
 * changes — all 10 chain families work over A2A for free, exactly as they work over HTTP.
 *
 * This module imports ONLY `server.ts`/`x402.ts` types + `errors.ts` (the same surface as
 * the Express adapter) — NO `viem`, NO chain SDK. It never touches a chain.
 *
 * ── Charter-critical invariants ───────────────────────────────────────────────
 *  • Defaults byte-identical: a root install that never imports A2A loads nothing extra.
 *  • B4 — NO new verification state: the buyer carries the challenge nonce in its payload;
 *    `gate.verifyObject` reads `sig.payload.nonce` exactly as HTTP does, and the gate
 *    re-derives every trusted field from the merchant's own config. The `A2ATaskStore` is
 *    transport task-lifecycle ONLY (receipt history), never on the verification path.
 *  • B5 — HTTP and A2A MUST share ONE replay set: `createA2APaymentHandler` takes an
 *    EXISTING `PaymentGate` (the primary, ergonomic form). A co-resident HTTP gate that
 *    builds a SEPARATE gate must share `isUsed`/`markUsed`, or a proof settled over one
 *    transport can be replayed over the other.
 *  • B7 — `receipts[]` is the UNION `(X402Receipt | SettleOutcome)[]` (it carries FAILED
 *    attempts); a fulfill-throws-AFTER-settle ends the Task `completed` with the successful
 *    receipt + an error annotation (NEVER re-challenge / failed — the money already moved).
 *  • Emit `x402Version: 2` — RESOLVED 2026-06-21: v2 IS the live x402 standard. A live cross-check
 *    against Google's official libs (reproducible harness in `examples/a2a-interop/`) showed the canonical
 *    `x402` lib (2.13.1, V2: `amount` / CAIP-2 / nested `accepted`) parses our PaymentRequired +
 *    PaymentPayload byte-identically, while the legacy v0.1 `x402_a2a` package (x402Version 1,
 *    `maxAmountRequired`, chain slugs) is bitrotted. Inbound v1 object-cores are absorbed for the
 *    standard `exact` scheme; PipRail-native `onchain-proof` is always v2 (never sent v1-flat).
 *  • Merchant statuses are spec-bounded: `payment-required` (a genuine first/no-proof challenge) /
 *    `payment-completed` / `payment-failed`. A SUBMITTED proof that fails verification (expired /
 *    wrong-amount / replayed) emits `payment-failed` — the a2a.md §9 rule ("If a payment fails, the
 *    server MUST set x402.payment.status to payment-failed") and its EXPIRED-signature example, which
 *    Google's reference executor matches verbatim (`is_valid == false → record_payment_failure →
 *    PAYMENT_FAILED`). Retryability rides on the A2A Task `state` (`input-required`), NOT the status —
 *    so a rejection is `payment-failed` + `input-required` (retry) while a terminal settlement error is
 *    `payment-failed` + `failed`. `payment-rejected` + `payment-submitted` are CLIENT→merchant statuses
 *    we never emit.
 *
 * ── DEFERRED (NOT built here — see the x402-parity/03-a2a-transport plan) ──────
 *  • Phase 4 — the A2A BUYER (`A2APayer`): the HTTP buyer mints the payload that rides A2A today.
 *  • Phase 5 — AP2 `CartMandate`/`PaymentMandate` carriage (the Embedded Flow; no mandate-trust machinery).
 *  • B8 ship-gate — RESOLVED at the wire level (above). A live `adk-demo` AGENT run is blocked by that
 *    package's dependency bitrot (won't import on current `x402`/`a2a-sdk`), not by PipRail.
 */

import type { PaymentGate, RequirePaymentOptions, VerifyPaymentResult } from '../server.js'
import { createPaymentGate } from '../server.js'
import type {
  X402Challenge,
  X402Receipt,
  SettleOutcome,
  VerifyErrorCode,
} from '../x402.js'
import { SettlementError } from '../errors.js'
import type {
  A2AArtifact,
  A2AExtensionDeclaration,
  A2AMessage,
  A2AMetadata,
  A2APart,
  A2APaymentStatus,
  A2ATask,
  A2ATaskRecord,
  A2ATaskStore,
} from './a2a-types.js'

/* ----------------------------- constants ----------------------------- */

/** The x402 A2A extension URI the x402-foundation doc + ALL Google reference code cite
 *  (`config.py:23`, `version="0.1"`). The seller's default — activation is exact-string match. */
export const A2A_X402_EXTENSION_URI_V01 = 'https://github.com/google-a2a/a2a-x402/v0.1'
/** The newer v0.2 URI (`spec/v0.2/spec.md:11`) — for AP2 Embedded-Flow targets (Phase 5, deferred). */
export const A2A_X402_EXTENSION_URI_V02 =
  'https://github.com/google-agentic-commerce/a2a-x402/blob/main/spec/v0.2'

/** The five canonical metadata keys (verbatim from `x402_a2a/types/state.py:33-37`). */
export const A2A_STATUS_KEY = 'x402.payment.status'
export const A2A_REQUIRED_KEY = 'x402.payment.required'
export const A2A_PAYLOAD_KEY = 'x402.payment.payload'
export const A2A_RECEIPTS_KEY = 'x402.payment.receipts'
export const A2A_ERROR_KEY = 'x402.payment.error'

/** The HTTP activation header a client sends to opt into the extension (§2.4). */
export const A2A_EXTENSIONS_HEADER = 'X-A2A-Extensions'

/** Hard cap on a single task's append-only `receipts[]` history — a real task holds 1–2 entries;
 *  this bounds memory if a caller pins one taskId and streams throw-producing payloads (a degraded
 *  backend). The tail is kept (the most recent settlement outcomes). */
const MAX_TASK_RECEIPTS = 64

/**
 * Map PipRail's lowercase {@link VerifyErrorCode} to the spec's screaming-snake error enum
 * (`errors.py:148-157` / spec §8.1) for `x402.payment.error`. We ALSO emit the raw PipRail
 * code (in the re-challenge's `extensions.piprail`), so nothing is lost and a buyer agent
 * branches identically across transports. Codes with no spec analogue map to `SETTLEMENT_FAILED`
 * only when they're settlement-side; rejection codes keep their nearest enum member.
 */
export const VERIFY_CODE_TO_A2A_ERROR: Record<string, string> = {
  payment_expired: 'EXPIRED_PAYMENT',
  tx_already_used: 'DUPLICATE_NONCE',
  // Genuine amount mismatches only — the spec defines INVALID_AMOUNT as "the payment amount does
  // not match the required amount" (a2a.md §9.1), so keep it strictly for amount errors.
  amount_too_low: 'INVALID_AMOUNT',
  upto_settle_exceeds_max: 'INVALID_AMOUNT',
  signature_invalid: 'INVALID_SIGNATURE',
  // NOT amount mismatches — a proof for an unoffered asset/network, or paid to the wrong recipient.
  // The spec's 7-member enum (errors.py x402ErrorCode) has no WRONG_RECIPIENT/TRANSFER_NOT_FOUND, so
  // these map to SETTLEMENT_FAILED — its explicit catch-all "the transaction failed on-chain for a
  // reason other than the above" (a2a.md §9.1) — never INVALID_AMOUNT, which would mislead a buyer
  // into retrying with a corrected amount. The raw PipRail code still rides in extensions.piprail.
  transfer_not_found: 'SETTLEMENT_FAILED',
  wrong_recipient: 'SETTLEMENT_FAILED',
  tx_reverted: 'SETTLEMENT_FAILED',
  tx_not_found: 'EXPIRED_PAYMENT',
  insufficient_confirmations: 'EXPIRED_PAYMENT',
  no_meta: 'INVALID_SIGNATURE',
  // The settlement-side throw code the handler emits for a SettlementError (the merchant's
  // relayer/facilitator never moved funds) — maps to the spec's SETTLEMENT_FAILED.
  settlement_failed: 'SETTLEMENT_FAILED',
}

/** Translate a PipRail verify/settle code to the A2A error enum (falls back to the raw code). */
export function toA2AErrorCode(code: string): string {
  return VERIFY_CODE_TO_A2A_ERROR[code] ?? code
}

/* ----------------------------- codec (low-level, pure) ----------------------------- */

/**
 * Build the `input-required` payment-request Task carrying the challenge as RAW JSON
 * (NOT base64) in `x402.payment.required` + `x402.payment.status = 'payment-required'`.
 * `parts` are any human-readable message parts the merchant wants alongside it.
 *
 * Returns a **transport-metadata** Task: it carries the x402 `payment` state, NOT the host-owned
 * ids the `@a2a-js/sdk` runtime requires (`Task.contextId`, `status.message.messageId`/`parts`,
 * `artifacts[].artifactId` are all REQUIRED in the SDK's types). The host adapter stamps those
 * before publishing — see the `@a2a-js/sdk` mount in the docs / `examples/a2a-server/lib.mjs`.
 * This keeps the protocol layer chain- and runtime-agnostic (zero `@a2a` dependency).
 */
export function toA2APaymentRequired(
  taskId: string,
  challenge: X402Challenge,
  parts?: A2APart[]
): A2ATask {
  const metadata: A2AMetadata = {
    [A2A_STATUS_KEY]: 'payment-required',
    [A2A_REQUIRED_KEY]: challenge,
  }
  return {
    kind: 'task',
    id: taskId,
    status: {
      state: 'input-required',
      message: { kind: 'message', role: 'agent', taskId, ...(parts ? { parts } : {}), metadata },
    },
  }
}

/** Build the `x402.payment.receipts` metadata block (an ARRAY, append-only, B7 union). */
export function toA2APaymentReceipts(receipts: (X402Receipt | SettleOutcome)[]): A2AMetadata {
  return { [A2A_RECEIPTS_KEY]: receipts }
}

/**
 * Build the `payment-failed` metadata for a SETTLEMENT-side failure (the money never moved):
 * the A2A error code + a `{ success:false, errorReason }` receipt appended to the history (B7).
 */
export function toA2APaymentFailed(
  code: VerifyErrorCode | string,
  detail: string,
  receipts: (X402Receipt | SettleOutcome)[] = [],
  network?: string
): A2AMetadata {
  // The x402 v2 SettlementResponse marks `transaction` Required ("empty string if settlement
  // failed", spec §SettleResponse) and the a2a.md failure-receipt example also carries `network`
  // — emit both (transaction:'' is never a missing key) so a conformant A2A buyer reads it cleanly.
  const entry: SettleOutcome = {
    success: false,
    transaction: '',
    ...(network ? { network } : {}),
    errorReason: `${code}: ${detail}`,
  }
  return {
    [A2A_STATUS_KEY]: 'payment-failed',
    [A2A_ERROR_KEY]: toA2AErrorCode(code),
    [A2A_RECEIPTS_KEY]: [...receipts, entry],
  }
}

/** Read the `X402Challenge` back out of a payment-request Task's metadata (raw JSON). */
export function fromA2APaymentRequired(task: A2ATask): X402Challenge | null {
  const meta = task.status?.message?.metadata
  const required = meta?.[A2A_REQUIRED_KEY]
  if (!required || typeof required !== 'object') return null
  return required as X402Challenge
}

/**
 * Read the inbound RAW payment payload object + its correlating `taskId` out of a
 * `message/send`. The raw object is fed straight into `gate.verifyObject` (the tolerant
 * object-cores absorb v1+v2). Returns `null` when there's no payload metadata.
 */
export function fromA2APaymentPayload(
  message: A2AMessage
): { raw: unknown; taskId: string } | null {
  const raw = message.metadata?.[A2A_PAYLOAD_KEY]
  if (raw === undefined || raw === null) return null
  return { raw, taskId: message.taskId ?? '' }
}

/* ----------------------------- the seller handler ----------------------------- */

/** Options for {@link createA2APaymentHandler}. */
export interface A2APaymentHandlerOptions extends Partial<RequirePaymentOptions> {
  /**
   * B5 (MANDATORY cross-transport replay): pass the SAME {@link PaymentGate} instance the
   * HTTP path uses, so both transports share ONE replay set (`localUsed` / injected
   * `isUsed`/`markUsed`). This is the PRIMARY, ergonomic form. If omitted, a fresh gate is
   * built from the inline `RequirePaymentOptions` — and a co-resident HTTP gate MUST then
   * share `isUsed`/`markUsed`, or a proof settled over one transport can be replayed over
   * the other.
   */
  gate?: PaymentGate
  /**
   * A bounded, pluggable TRANSPORT-lifecycle store (B4) — correlate a follow-up
   * `message/send` to its in-flight Task + accumulate the append-only `receipts[]`. It is
   * NOT on the verification path and holds NO nonce-as-security-state (the buyer carries the
   * nonce in its payload). Default = an in-memory TTL Map (same bound as the replay set).
   * NOT a backend PipRail hosts.
   */
  taskStore?: A2ATaskStore
  /** TTL (ms) for the default task store. Default = `maxTimeoutSeconds * 1000` (the replay window). */
  taskTtlMs?: number
  /**
   * Produce the served result Artifact(s) for a settled task — the merchant's own work (the
   * image, the JSON, …). Charter-safe: like an Express route handler that runs after `next()`.
   * Omit for a metadata-only "payment accepted" completion. **B7: if this THROWS after a
   * successful settle, the Task still completes `completed` carrying the success receipt + an
   * error annotation — the buyer is NEVER told to re-pay an already-settled proof.**
   */
  fulfill?: (ctx: {
    taskId: string
    receipt: X402Receipt
    message: A2AMessage
  }) => Promise<A2AArtifact[]> | A2AArtifact[]
}

/** The seller handler returned by {@link createA2APaymentHandler}. */
export interface A2APaymentHandler {
  /**
   * Process one inbound A2A message and return the next Task. Outcomes mirror
   * `gate.verify()`'s `VerifyPaymentResult` exactly:
   *  - no payload yet            → Task `input-required` + `x402.payment.required`
   *  - payload, verified+settled → Task `completed` + `x402.payment.receipts` + artifacts
   *  - payload, rejected         → Task `input-required` re-challenge, status `payment-failed` (RETRYABLE)
   *  - settle threw (relayer)    → Task `failed` + `x402.payment.error`  (NOT retryable)
   *  - settle OK but fulfill threw → Task `completed` + receipt + error annotation (B7)
   *
   * The returned Task is **transport metadata only** — it carries the x402 `payment.*` state but NOT
   * the host-owned ids the `@a2a-js/sdk` runtime requires (`Task.contextId`, `status.message.messageId`
   * /`parts`, `artifacts[].artifactId`). The host adapter (the `AgentExecutor`) stamps those before
   * `bus.publish` — see the mount in the docs / `examples/a2a-server/lib.mjs`. This keeps the protocol
   * layer free of any `@a2a` dependency.
   */
  handleMessage(message: A2AMessage, taskId?: string): Promise<A2ATask>
  /** Stamp the x402 extension into an AgentCard's `capabilities.extensions` (§2.4). */
  agentCardExtension(opts?: {
    required?: boolean
    version?: 'v0.1' | 'v0.2'
  }): A2AExtensionDeclaration
  /** The underlying gate — escape hatch for advanced flows (`describe()`, `landingPage()`). */
  readonly gate: PaymentGate
}

/** A default bounded, TTL-evicted in-memory task store — clones the gate's replay-set posture
 *  (a Map inside the merchant's own process; NOT a backend). Front-swept by insertion order. */
function defaultTaskStore(): A2ATaskStore {
  const map = new Map<string, { record: A2ATaskRecord; expiry: number }>()
  function prune(now: number): void {
    for (const [key, { expiry }] of map) {
      if (expiry > now) break
      map.delete(key)
    }
  }
  return {
    get(taskId) {
      const now = Date.now()
      prune(now)
      const hit = map.get(taskId)
      return hit && hit.expiry > now ? hit.record : undefined
    },
    set(taskId, value, ttlMs) {
      const now = Date.now()
      prune(now)
      // Re-insert at the tail so the insertion-order front-sweep stays monotonic.
      map.delete(taskId)
      map.set(taskId, { record: value, expiry: now + ttlMs })
    },
  }
}

/**
 * The A2A analogue of `requirePayment` — wrap a {@link PaymentGate} and map A2A messages ⇄
 * x402 task metadata. The merchant plugs `handleMessage` into their A2A agent's
 * `message/send` handler and pushes `agentCardExtension()` into their AgentCard.
 *
 * @example
 * ```ts
 * import { createPaymentGate, createA2APaymentHandler } from '@piprail/sdk'
 *
 * const gate = createPaymentGate({ chain: 'base', token: 'USDC', amount: '0.05', payTo: '0x…' })
 * const pay = createA2APaymentHandler({ gate, fulfill: async () => [{ name: 'result', parts: [{ kind: 'text', text: 'done' }] }] })
 * a2aAgent.on('message/send', ({ message, taskId }) => pay.handleMessage(message, taskId))
 * ```
 */
export function createA2APaymentHandler(options: A2APaymentHandlerOptions): A2APaymentHandler {
  // B5: prefer an EXISTING gate (shared replay set). Only build one if none is passed.
  const gate: PaymentGate = options.gate ?? createPaymentGate(options as RequirePaymentOptions)
  const maxTimeoutSeconds = options.maxTimeoutSeconds ?? 600
  const ttlMs = options.taskTtlMs ?? maxTimeoutSeconds * 1000
  const store: A2ATaskStore = options.taskStore ?? defaultTaskStore()

  /** Append a settlement entry to a task's append-only history (B7 union) + persist. */
  function appendReceipt(taskId: string, entry: X402Receipt | SettleOutcome): (X402Receipt | SettleOutcome)[] {
    const prior = store.get(taskId)?.receipts ?? []
    // Dedupe a successful X402Receipt on its settlement tx (the idempotency key) so a
    // re-presented proof never double-lists. Failed SettleOutcomes have no tx → always append.
    // A tx-SUPPRESSED success (`receipts.includeTxHash:false` → `transaction:''`) must ALSO always
    // append: an empty string is not an idempotency key, and a prior failure receipt also carries
    // `transaction:''`, so deduping on it would silently drop the success and ship a `payment-completed`
    // task carrying only the earlier failure. Same "empty tx never dedupes" reasoning as failures.
    const isDup =
      'success' in entry &&
      entry.success === true &&
      entry.transaction !== '' &&
      prior.some((r) => 'transaction' in r && (r as X402Receipt).transaction === entry.transaction)
    const next = isDup ? prior : [...prior, entry]
    // BOUND the per-task history: a hostile/buggy caller pinning one taskId and sending payloads
    // that each throw on the verify read (a degraded merchant backend) would otherwise append a
    // failed SettleOutcome without limit (they never dedup) → unbounded memory under one task.
    // Keep only the most-recent MAX_TASK_RECEIPTS (a real task holds 1–2). Append-only semantics
    // for normal use are unchanged; only a pathological stream is capped.
    const receipts = next.length > MAX_TASK_RECEIPTS ? next.slice(-MAX_TASK_RECEIPTS) : next
    store.set(taskId, { receipts }, ttlMs)
    return receipts
  }

  /** Build a `completed` Task carrying the receipts[] history + artifacts (+ optional B7 annotation). */
  function completedTask(
    taskId: string,
    receipts: (X402Receipt | SettleOutcome)[],
    artifacts: A2AArtifact[],
    status: A2APaymentStatus = 'payment-completed'
  ): A2ATask {
    const metadata: A2AMetadata = { [A2A_STATUS_KEY]: status, ...toA2APaymentReceipts(receipts) }
    return {
      kind: 'task',
      id: taskId,
      status: { state: 'completed', message: { kind: 'message', role: 'agent', taskId, metadata } },
      ...(artifacts.length > 0 ? { artifacts } : {}),
    }
  }

  /** Build a re-challenge `input-required` Task from a `kind:'invalid'`/`challenge` verdict.
   *  RETRYABLE (§3.6) — both transient AND definitive rejections re-challenge (the gate's whole
   *  model is "here's a fresh challenge, try again"); only a SettlementError maps to `failed`. */
  function reChallengeTask(
    taskId: string,
    result: Extract<VerifyPaymentResult, { kind: 'challenge' | 'invalid' }>,
    attempted?: string
  ): A2ATask {
    // A genuine first/re-issued challenge (no proof was submitted to reject) → `payment-required`,
    // no receipt — identical to toA2APaymentRequired but on an existing task.
    if (result.kind !== 'invalid') {
      const metadata: A2AMetadata = {
        [A2A_STATUS_KEY]: 'payment-required',
        [A2A_REQUIRED_KEY]: result.challenge,
      }
      return {
        kind: 'task',
        id: taskId,
        status: { state: 'input-required', message: { kind: 'message', role: 'agent', taskId, metadata } },
      }
    }
    // A SUBMITTED proof was REJECTED (expired/wrong-amount/replayed). Per the a2a.md §9 rule — "If a
    // payment fails, the server MUST set x402.payment.status to payment-failed" — and its worked
    // EXPIRED-signature example (a verification failure, exactly this `kind:'invalid'` class) emitting
    // `payment-failed` + `x402.payment.error`, the merchant status is `payment-failed`. Google's
    // reference executor matches it verbatim: `verify_response.is_valid == false → _fail_payment →
    // record_payment_failure`, which sets `PAYMENT_FAILED` + the error code + a failure receipt while
    // leaving the Task `state` `input-required`. RETRYABILITY is carried by that `input-required`
    // state, NOT by the status — so this stays retryable: we re-issue `x402.payment.required` on the
    // SAME task with a fresh challenge so the buyer can fix + retry. (`payment-rejected` is the OTHER,
    // client→merchant status — the client rejecting our offered requirements — which we never emit.)
    // Prefer the network the buyer ACTUALLY attempted (from its submitted payload) — the right
    // attribution even on a multi-network gate where singleNetworkOf can't pick one.
    const network = attempted ?? singleNetworkOf(result.challenge)
    const receipts = appendReceiptFailed(taskId, result.error, result.detail, network)
    const metadata: A2AMetadata = {
      [A2A_STATUS_KEY]: 'payment-failed',
      [A2A_ERROR_KEY]: toA2AErrorCode(result.error),
      [A2A_REQUIRED_KEY]: result.challenge,
      ...toA2APaymentReceipts(receipts),
    }
    return {
      kind: 'task',
      id: taskId,
      status: { state: 'input-required', message: { kind: 'message', role: 'agent', taskId, metadata } },
    }
  }

  /** Build a `failed` Task for a SETTLEMENT-side error (the money never moved). `network` is the
   *  CAIP-2 the buyer attempted (from the submitted payload) so the failure receipt carries it. */
  function failedTask(taskId: string, code: string, detail: string, network?: string): A2ATask {
    const receipts = appendReceiptFailed(taskId, code, detail, network)
    const metadata: A2AMetadata = {
      [A2A_STATUS_KEY]: 'payment-failed',
      [A2A_ERROR_KEY]: toA2AErrorCode(code),
      ...toA2APaymentReceipts(receipts),
    }
    return {
      kind: 'task',
      id: taskId,
      status: { state: 'failed', message: { kind: 'message', role: 'agent', taskId, metadata } },
    }
  }

  /** Append a failed SettleOutcome to the history (B7). The x402 v2 SettlementResponse marks
   *  `transaction` Required ("empty string if settlement failed", spec §SettleResponse) and the
   *  a2a.md failure-receipt example also carries `network` — emit `transaction: ''` (never a
   *  missing key) plus `network` when known, for a conformant A2A buyer reading receipts[]. */
  function appendReceiptFailed(
    taskId: string,
    code: string,
    detail: string,
    network?: string
  ): (X402Receipt | SettleOutcome)[] {
    return appendReceipt(taskId, {
      success: false,
      transaction: '',
      ...(network ? { network } : {}),
      errorReason: `${code}: ${detail}`,
    })
  }

  async function handleMessage(message: A2AMessage, taskId?: string): Promise<A2ATask> {
    const id = taskId ?? message.taskId ?? newTaskId()

    // ── no payload yet → a fresh payment-required challenge ────────────────────────
    const inbound = fromA2APaymentPayload(message)
    if (!inbound) {
      const { challenge } = await gate.challenge(resourceUrlFromMessage(message))
      // Seed the task record so a follow-up submission correlates (receipt history only — B4).
      store.set(id, { receipts: [] }, ttlMs)
      return toA2APaymentRequired(id, challenge)
    }

    // ── payload present → run the SAME dispatch as HTTP on the RAW object (B4) ──────
    // gate.verifyObject reads sig.payload.nonce off the object exactly as HTTP does, re-derives
    // every trusted field from the merchant's own config, and shares the gate's ONE replay set.
    // The network the buyer ATTEMPTED (from its payload, v2 or v1-flat) attributes every failure
    // receipt's `network` — even on a multi-network gate where the challenge can't pick one.
    const attempted = networkFromPayload(inbound.raw)
    let result: VerifyPaymentResult
    try {
      result = await gate.verifyObject(inbound.raw)
    } catch (err) {
      // A SettlementError (the relayer/facilitator never moved funds — the merchant's fault, not
      // the buyer's) → terminal `failed`. Re-submitting the same auth won't help until the merchant
      // fixes their relayer. The discriminator is "did the money move": here it did NOT.
      if (err instanceof SettlementError) {
        return failedTask(id, 'settlement_failed', err.message, attempted)
      }
      // Any other throw (an RPC blip on the verify read) is transient — surface as a `failed`
      // with the message, NOT a silent crash. The buyer's still-valid proof can be re-presented.
      const detail = err instanceof Error ? err.message : String(err)
      return failedTask(id, 'tx_reverted', detail, attempted)
    }

    switch (result.kind) {
      case 'challenge':
        // No usable proof in the payload (e.g. a malformed/empty payload object) → re-challenge.
        return reChallengeTask(id, result, attempted)

      case 'invalid':
        // A rejected proof (wrong amount, expired, replayed, transient RPC lag, …) → a conformant
        // re-challenge (RETRYABLE) carrying the reason — mirrors the HTTP `kind:'invalid'` 402.
        return reChallengeTask(id, result, attempted)

      case 'paid': {
        // The money MOVED. From here the proof is final (at-most-once). Append the success receipt
        // FIRST so it's recorded even if fulfill throws (B7). onPaid already fired inside the gate.
        const receipts = appendReceipt(id, result.receipt)
        let artifacts: A2AArtifact[] = []
        if (options.fulfill) {
          try {
            artifacts = (await options.fulfill({ taskId: id, receipt: result.receipt, message })) ?? []
          } catch (err) {
            // B7: fulfill threw AFTER a successful settle → the Task still ends `completed` carrying
            // the success receipt + an error annotation on a synthetic artifact. NEVER re-challenge /
            // failed — either would mislead the buyer into re-paying a proof that already settled.
            const detail = err instanceof Error ? err.message : String(err)
            const annotation: A2AArtifact = {
              name: 'fulfillment-error',
              metadata: { 'x402.fulfillment.error': detail, 'x402.fulfillment.settled': true },
              parts: [{ kind: 'text', text: `Payment settled, but serving the result failed: ${detail}` }],
            }
            return completedTask(id, receipts, [annotation])
          }
        }
        return completedTask(id, receipts, artifacts)
      }
    }
  }

  function agentCardExtension(opts?: {
    required?: boolean
    version?: 'v0.1' | 'v0.2'
  }): A2AExtensionDeclaration {
    const uri = opts?.version === 'v0.2' ? A2A_X402_EXTENSION_URI_V02 : A2A_X402_EXTENSION_URI_V01
    return {
      uri,
      description: 'Supports payments using the x402 protocol for on-chain settlement.',
      ...(opts?.required ? { required: true } : {}),
    }
  }

  return { handleMessage, agentCardExtension, gate }
}

/* ----------------------------- small helpers ----------------------------- */

/** The single CAIP-2 network a challenge's rails all share, for a failure receipt's `network`
 *  field — `undefined` if the challenge offers rails on more than one network (then we can't
 *  attribute the rejection to one) or none. Best-effort; the SettleOutcome field is optional. */
function singleNetworkOf(challenge: X402Challenge): string | undefined {
  const nets = new Set((challenge.accepts ?? []).map((a) => a.network).filter(Boolean))
  return nets.size === 1 ? [...nets][0] : undefined
}

/** Best-effort CAIP-2 network the buyer attempted, read from a submitted payment payload, for a
 *  failure receipt's `network` field. Reads the v2 `accepted.network` first, then the v1-FLAT
 *  top-level `network` (parseExactObject accepts both). Tolerates any shape (the verify already
 *  failed) — returns `undefined` when absent/malformed. */
function networkFromPayload(raw: unknown): string | undefined {
  const v = raw as { accepted?: { network?: unknown }; network?: unknown } | null
  if (v && typeof v.accepted?.network === 'string') return v.accepted.network
  if (v && typeof v.network === 'string') return v.network
  return undefined
}

/** A fresh A2A task id when the caller didn't supply one. */
function newTaskId(): string {
  return `task-${globalThis.crypto.randomUUID()}`
}

/** Best-effort resource URL for the challenge, read from a structured message part if present.
 *  A2A has no inherent URL (it's task-initiated), so this is purely cosmetic for the challenge. */
function resourceUrlFromMessage(message: A2AMessage): string {
  for (const part of message.parts ?? []) {
    const data = part.data as { url?: unknown } | undefined
    if (data && typeof data.url === 'string') return data.url
  }
  return ''
}

// Re-export the duck-typed A2A shapes so a consumer imports everything from `@piprail/sdk`
// (all A2A symbols are surfaced from the main entry; there is no separate subpath).
export type {
  A2AArtifact,
  A2AExtensionDeclaration,
  A2AMessage,
  A2AMetadata,
  A2APart,
  A2APaymentStatus,
  A2ATask,
  A2ATaskRecord,
  A2ATaskState,
  A2ATaskStore,
} from './a2a-types.js'

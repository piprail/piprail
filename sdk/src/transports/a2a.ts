/**
 * x402-over-A2A — the SELLER-side transport adapter (Google Agent2Agent).
 *
 * A2A is x402's third official transport (alongside HTTP and MCP). It carries PipRail's
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
 *  • Emit strict `x402Version: 2` (the inbound object-cores absorb v1). The emit version is
 *    the deferred B8 live-interop ship-gate — do NOT change it here.
 *
 * ── DEFERRED (NOT built here — see the x402-parity/03-a2a-transport plan) ──────
 *  • Phase 4 — the A2A BUYER (`A2APayer`): trails on live interop.
 *  • Phase 5 — AP2 `CartMandate`/`PaymentMandate` carriage (payment-carriage only, no
 *    mandate-trust machinery).
 *  • B8 ship-gate — the live Google `adk-demo` reference-client run + the final v1-vs-v2
 *    emit-version decision (a live-runtime gate, not buildable offline).
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
  amount_too_low: 'INVALID_AMOUNT',
  upto_settle_exceeds_max: 'INVALID_AMOUNT',
  signature_invalid: 'INVALID_SIGNATURE',
  transfer_not_found: 'INVALID_AMOUNT',
  wrong_recipient: 'INVALID_AMOUNT',
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
  receipts: (X402Receipt | SettleOutcome)[] = []
): A2AMetadata {
  const entry: SettleOutcome = { success: false, errorReason: `${code}: ${detail}` }
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
   *  - payload, rejected         → Task `input-required` re-challenge (RETRYABLE)
   *  - settle threw (relayer)    → Task `failed` + `x402.payment.error`  (NOT retryable)
   *  - settle OK but fulfill threw → Task `completed` + receipt + error annotation (B7)
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
 * import { createPaymentGate } from '@piprail/sdk'
 * import { createA2APaymentHandler } from '@piprail/sdk/a2a'
 *
 * const gate = createPaymentGate({ chain: 'base', token: 'USDC', amount: '0.05', payTo: '0x…' })
 * const pay = createA2APaymentHandler({ gate, fulfill: async () => [{ kind: 'text', text: 'done' }] })
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
    const isDup =
      'success' in entry &&
      entry.success === true &&
      prior.some((r) => 'transaction' in r && (r as X402Receipt).transaction === entry.transaction)
    const receipts = isDup ? prior : [...prior, entry]
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
    result: Extract<VerifyPaymentResult, { kind: 'challenge' | 'invalid' }>
  ): A2ATask {
    const metadata: A2AMetadata = {
      [A2A_STATUS_KEY]: 'payment-required',
      [A2A_REQUIRED_KEY]: result.challenge,
      ...(result.kind === 'invalid' ? { [A2A_ERROR_KEY]: toA2AErrorCode(result.error) } : {}),
    }
    return {
      kind: 'task',
      id: taskId,
      status: { state: 'input-required', message: { kind: 'message', role: 'agent', taskId, metadata } },
    }
  }

  /** Build a `failed` Task for a SETTLEMENT-side error (the money never moved). */
  function failedTask(taskId: string, code: string, detail: string): A2ATask {
    const receipts = appendReceiptFailed(taskId, code, detail)
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

  /** Append a failed SettleOutcome to the history (B7). */
  function appendReceiptFailed(taskId: string, code: string, detail: string): (X402Receipt | SettleOutcome)[] {
    return appendReceipt(taskId, { success: false, errorReason: `${code}: ${detail}` })
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
    let result: VerifyPaymentResult
    try {
      result = await gate.verifyObject(inbound.raw)
    } catch (err) {
      // A SettlementError (the relayer/facilitator never moved funds — the merchant's fault, not
      // the buyer's) → terminal `failed`. Re-submitting the same auth won't help until the merchant
      // fixes their relayer. The discriminator is "did the money move": here it did NOT.
      if (err instanceof SettlementError) {
        return failedTask(id, 'settlement_failed', err.message)
      }
      // Any other throw (an RPC blip on the verify read) is transient — surface as a `failed`
      // with the message, NOT a silent crash. The buyer's still-valid proof can be re-presented.
      const detail = err instanceof Error ? err.message : String(err)
      return failedTask(id, 'tx_reverted', detail)
    }

    switch (result.kind) {
      case 'challenge':
        // No usable proof in the payload (e.g. a malformed/empty payload object) → re-challenge.
        return reChallengeTask(id, result)

      case 'invalid':
        // A rejected proof (wrong amount, expired, replayed, transient RPC lag, …) → a conformant
        // re-challenge (RETRYABLE) carrying the reason — mirrors the HTTP `kind:'invalid'` 402.
        return reChallengeTask(id, result)

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

// Re-export the duck-typed A2A shapes so a consumer imports everything from `@piprail/sdk/a2a`.
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

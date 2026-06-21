/**
 * Minimal, DUCK-TYPED Agent2Agent (A2A) shapes — the structural surface the PipRail A2A
 * transport reads/writes, and NOTHING more. Like `ExpressLikeRequest` in `server.ts`, these
 * declare only the fields the adapter touches, so any A2A runtime's objects (the official
 * `@a2a-js/sdk` — `a2aproject` org, the Linux Foundation A2A project — ADK, or a hand-rolled
 * JSON-RPC handler) satisfy them structurally — **with ZERO `@a2a` dependency**.
 *
 * x402-over-A2A carries PipRail's existing `PaymentRequired`/`PaymentPayload`/
 * `SettlementResponse` envelopes inside A2A `Task`/`Message` `metadata`, keyed off five
 * namespaced keys (`x402.payment.{status,required,payload,receipts,error}`), so a
 * standard A2A reader ignores them and they coexist with any other metadata.
 *
 * Verified verbatim against the upstream reference `x402_a2a/types/state.py` and the
 * x402-foundation `specs/transports-v2/a2a.md` mapping table.
 */

import type { X402Challenge, X402Receipt, SettleOutcome } from '../x402.js'

/** The coarse A2A Task state (the A2A framework's own lifecycle). */
export type A2ATaskState =
  | 'submitted'
  | 'working'
  | 'input-required'
  | 'completed'
  | 'failed'
  | 'canceled'

/** The granular `x402.payment.status` lifecycle field (the payment state machine atop the
 *  Task state). Per `transports-v2/a2a.md:217-224` + the reference `PaymentStatus` enum. */
export type A2APaymentStatus =
  | 'payment-required'
  | 'payment-submitted'
  | 'payment-verified'
  | 'payment-completed'
  | 'payment-failed'
  | 'payment-rejected'

/** A part of an A2A Message — text, data, or file. Only the fields the adapter reads/writes. */
export interface A2APart {
  kind?: 'text' | 'data' | 'file' | string
  text?: string
  data?: unknown
  [extra: string]: unknown
}

/** An A2A Artifact — the merchant's served work attached to a completed Task. The adapter
 *  attaches `fulfill()`'s output here, plus (B7) an optional post-settle error annotation. */
export interface A2AArtifact {
  artifactId?: string
  name?: string
  parts?: A2APart[]
  /** Free-form annotation bag. The B7 fulfill-throws-after-settle edge stamps a post-settle
   *  error here (NEVER re-challenge / failed) so the buyer sees the work failed AFTER paying. */
  metadata?: Record<string, unknown>
  [extra: string]: unknown
}

/**
 * The five canonical x402 metadata keys (namespaced `x402.payment.*`) plus structural
 * tolerance for any other A2A metadata. The shapes are PipRail's EXISTING wire objects —
 * `x402.payment.required` is a raw `X402Challenge` (NOT base64), `x402.payment.payload` is
 * a raw PaymentPayload object (fed to the tolerant object-cores via `gate.verifyObject`),
 * and `x402.payment.receipts` is the append-only history.
 */
export interface A2AMetadata {
  'x402.payment.status'?: A2APaymentStatus
  'x402.payment.required'?: X402Challenge
  /** A raw `X402PaymentSignature` / exact / upto payload object — fed straight into
   *  `gate.verifyObject` (the tolerant object-cores absorb v1+v2). */
  'x402.payment.payload'?: unknown
  /**
   * B7: append-only settlement history. The element type is the UNION because the array
   * MUST include FAILED attempts (`spec v0.1:281`) — and `X402Receipt.success` is the literal
   * `true`, so a failed entry can only be a `SettleOutcome { success:false, errorReason }`.
   */
  'x402.payment.receipts'?: (X402Receipt | SettleOutcome)[]
  /** The error code on a settlement-side failure (`x402.payment.error`). */
  'x402.payment.error'?: string
  [extra: string]: unknown
}

/** An inbound/outbound A2A Message. The submission carries the payload + the original
 *  `taskId` for correlation (`v0.1 spec.md:163`). Only the fields the adapter touches. */
export interface A2AMessage {
  kind?: 'message'
  role?: string
  /** Correlates a follow-up payment submission to its in-flight payment Task. */
  taskId?: string
  messageId?: string
  parts?: A2APart[]
  metadata?: A2AMetadata
  [extra: string]: unknown
}

/** An A2A Task — the merchant's response carrying the payment state in `status.message.metadata`. */
export interface A2ATask {
  kind?: 'task'
  id: string
  status: {
    state: A2ATaskState
    message?: A2AMessage
  }
  artifacts?: A2AArtifact[]
  [extra: string]: unknown
}

/**
 * An AgentCard extension declaration — what the merchant stamps into its
 * `AgentCard.capabilities.extensions[]` to advertise the x402 extension (§2.4). A client
 * opts in by sending `X-A2A-Extensions: <uri>`; `required: true` rejects un-activated callers.
 */
export interface A2AExtensionDeclaration {
  uri: string
  description?: string
  required?: boolean
  params?: Record<string, unknown>
}

/**
 * A bounded, pluggable TRANSPORT-LIFECYCLE store — NOT a backend, NOT on the verification
 * path, holds NO security state (B4). It correlates a follow-up `message/send` to its
 * in-flight Task and accumulates the append-only `receipts[]` history. The buyer carries
 * the challenge nonce in its payload; `gate.verify`/`gate.verifyObject` re-derive every
 * trusted field from the merchant's own config (`server.ts` client-echoed nonce), so even
 * a poisoned/empty store can never redirect funds or reject a valid payment. Same posture
 * as the gate's in-memory replay set — a bounded Map inside the merchant's own process.
 */
export interface A2ATaskStore {
  get(taskId: string): A2ATaskRecord | undefined
  set(taskId: string, value: A2ATaskRecord, ttlMs: number): void
}

/** What a {@link A2ATaskStore} holds per task — the receipt history ONLY (no nonce-as-security). */
export interface A2ATaskRecord {
  receipts?: (X402Receipt | SettleOutcome)[]
}

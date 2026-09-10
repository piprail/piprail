/**
 * Mode-B settlement: delegate a standard `exact` payment to a THIRD-PARTY x402
 * facilitator the MERCHANT chooses (Coinbase CDP, x402.org, or any). PipRail hosts
 * nothing — this is two HTTP POSTs to the merchant's configured facilitator URL.
 *
 * PROTOCOL LAYER — pure `fetch`, ZERO chain libraries (STANDARDS §1). The other
 * settlement mode (self-settle with the merchant's own relayer key) lives in the
 * EVM driver; this one is chain-agnostic because the facilitator does the chain work.
 *
 * The wire contract (x402 v2, verified against coinbase/x402 core):
 *   POST {url}/verify   body { x402Version, paymentPayload, paymentRequirements } → { isValid, invalidReason?, payer? }
 *   POST {url}/settle   SAME body                                                → { success, transaction, network, payer?, errorReason? }
 * Both protocol outcomes are HTTP 200 (the boolean flips); a non-200 is a
 * transport/auth failure. There is no registration and no idempotency key — so a
 * SELF-settling merchant must guard replay itself (the gate's used-proof set does).
 */
import type { VerifyResult, VerifyErrorCode, X402Receipt, Caip2, AssetId, AddressId } from './x402.js'
import { SettlementError } from './errors.js'
import { normalizeNetwork } from './indexes.js'

/** Standard x402 `exact` PaymentRequirements, built from the gate's TRUSTED rail. `extra`
 *  carries the scheme's chain-specific fields: EVM EIP-3009 → `{ name, version }` (the token's
 *  EIP-712 domain), Solana SVM → `{ feePayer }` (the facilitator's fee-payer pubkey). */
export interface FacilitatorPaymentRequirements {
  scheme: 'exact'
  network: string
  asset: string
  amount: string
  payTo: string
  maxTimeoutSeconds: number
  extra: Record<string, unknown>
}

/**
 * Read a facilitator's **fee-payer pubkey** for a CAIP-2 `network` from its `GET /supported`
 * endpoint (the `extra.feePayer` of the matching `exact` kind). This is how a resource server
 * learns who will sponsor gas on a facilitator-settled **Solana** rail — so it can advertise
 * `extra.feePayer` and the buyer can build the transaction against it. With a facilitator like
 * PayAI the facilitator IS the fee payer, so **neither the buyer nor the merchant pays gas**.
 *
 * Best-effort + bounded (an `AbortController` timeout): returns `undefined` on any failure or
 * when the kind has no `feePayer` (EVM `exact` kinds carry none — EVM ignores this). Pure `fetch`,
 * no chain libraries (STANDARDS §1).
 */
export async function fetchFacilitatorFeePayer(
  url: string,
  network: string,
  /*
   * Sized for a COLD facilitator, not a warm one. These are serverless hosts: measured
   * 2026-09-09, x402.dexter.cash answered `/supported` in 8497ms cold and ~310ms warm. At the
   * previous 8000ms the cold read aborted, the fee payer came back undefined, and the gate
   * dropped its gasless `exact` rail — so the buyer paid gas because a facilitator was asleep.
   * The wait is bounded and paid at most once per gate, on a lazy probe that only runs when the
   * family cannot resolve `exact` without a fee payer (Solana; EVM never reaches it).
   */
  timeoutMs = 15_000
): Promise<string | undefined> {
  const base = url.replace(/\/+$/, '')
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(`${base}/supported`, { signal: ctrl.signal })
    if (!res.ok) return undefined
    const body = (await res.json()) as { kinds?: Array<{ scheme?: string; network?: string; extra?: Record<string, unknown> }> }
    const kinds = Array.isArray(body?.kinds) ? body.kinds : []
    // Match on the NORMALIZED network so a facilitator that reports a slug ("solana") or a CAIP-2
    // id both resolve — a strict `===` would silently miss a slug-reporting facilitator and drop
    // the Solana exact rail. normalizeNetwork passes a CAIP-2 id through unchanged.
    const want = normalizeNetwork(network)
    const kind = kinds.find((k) => k?.scheme === 'exact' && normalizeNetwork(String(k?.network ?? '')) === want)
    const fp = kind?.extra?.feePayer
    return typeof fp === 'string' ? fp : undefined
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

/** One (scheme, network) pair a facilitator's `GET /supported` advertises. */
export interface FacilitatorSupportedKind {
  scheme: string
  /** As the facilitator reports it — a CAIP-2 id or a slug. */
  network: string
  /** The fee-payer pubkey when the kind carries one (SVM rails). */
  feePayer?: string
  /** The kind's x402 envelope version when the facilitator reports it per-kind — e.g.
   *  AEON's `/supported` serves `{ x402Version, scheme, network }`, letting a reader tell
   *  a v1 from a v2 BNB rail. Optional — absent when the facilitator doesn't advertise it. */
  x402Version?: number
  /** The EVM exact transfer method (`eip3009` / `permit2`) when the facilitator advertises
   *  it in the kind's `extra` — so coverage can tell whether a BNB exact kind is gasless
   *  EIP-3009 or Permit2. Optional — most facilitators (AEON included) omit it. */
  assetTransferMethod?: string
}

/**
 * Parse a facilitator `/supported` body into its advertised (scheme, network) kinds.
 * PURE + tolerant: a malformed body yields `[]`. Mirrors the `{ kinds: [...] }` shape
 * {@link fetchFacilitatorFeePayer} reads. Useful for verifying coverage before wiring a gate,
 * and for generating the coverage doc from live reads.
 */
export function parseFacilitatorSupported(body: unknown): FacilitatorSupportedKind[] {
  const kinds = (body as { kinds?: unknown } | null)?.kinds
  if (!Array.isArray(kinds)) return []
  const out: FacilitatorSupportedKind[] = []
  for (const k of kinds) {
    if (!k || typeof k !== 'object') continue
    const o = k as {
      scheme?: unknown
      network?: unknown
      x402Version?: unknown
      extra?: { feePayer?: unknown; assetTransferMethod?: unknown }
    }
    if (typeof o.scheme !== 'string' || typeof o.network !== 'string') continue
    const fp = o.extra?.feePayer
    const ver = o.x402Version
    const method = o.extra?.assetTransferMethod
    out.push({
      scheme: o.scheme,
      network: o.network,
      ...(typeof fp === 'string' ? { feePayer: fp } : {}),
      ...(typeof ver === 'number' ? { x402Version: ver } : {}),
      ...(typeof method === 'string' ? { assetTransferMethod: method } : {}),
    })
  }
  return out
}

/**
 * Read a facilitator's LIVE coverage from `GET /supported`. Best-effort + bounded (an
 * `AbortController` timeout): NEVER throws — returns `[]` on any failure (same posture as
 * {@link fetchFacilitatorFeePayer}). Lets an operator/agent ask "does this facilitator
 * cover my network?" before wiring a gate. Pure `fetch`, no chain libraries (STANDARDS §1).
 *
 * 🌐 **Server-side in practice.** It reads `<url>/supported` cross-origin, and most
 * facilitators send no CORS header, so from a browser this returns `[]` rather than the real
 * capability list. An empty array is indistinguishable from "supports nothing", so branch on
 * it carefully in a page: the registry in `KNOWN_FACILITATORS` is static data and always works.
 */
export async function facilitatorCoverage(
  url: string,
  /** Cold-start sized, for the same reason as {@link fetchFacilitatorFeePayer}. */
  timeoutMs = 15_000
): Promise<FacilitatorSupportedKind[]> {
  const base = url.replace(/\/+$/, '')
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(`${base}/supported`, { signal: ctrl.signal })
    if (!res.ok) return []
    return parseFacilitatorSupported(await res.json())
  } catch {
    return []
  } finally {
    clearTimeout(timer)
  }
}

/** A merchant-chosen facilitator: its base URL + optional per-request auth headers. */
export interface FacilitatorConfig {
  /** Base URL, e.g. 'https://x402.org/facilitator' (trailing slash stripped). */
  url: string
  /** Optional async auth-header provider (e.g. CDP JWT). Omit for the free, no-auth facilitators. */
  authHeaders?: () => Promise<Record<string, string>>
}

export interface SettleViaFacilitatorInput extends FacilitatorConfig {
  x402Version: number
  /** The decoded PaymentPayload the client sent — forwarded verbatim. */
  paymentPayload: Record<string, unknown>
  /** PaymentRequirements built from the gate's trusted rail (never the client echo). */
  paymentRequirements: FacilitatorPaymentRequirements
  /** The receipt's network (CAIP-2) + asset/amount/payTo, for building the X402Receipt on success. */
  receipt: { network: Caip2; asset: AssetId; payTo: AddressId; amount: string }
  /** authorization.from, for the receipt's `payer`. */
  payerHint?: string
  /**
   * The gated resource, from the merchant's own trusted config (never the client echo).
   * x402 v2 facilitators may require it at the request root — Ultravioleta DAO refuses a
   * v2 body without it (`data did not match any variant of untagged enum VerifyRequestEnvelope`),
   * which silently blocked every non-EVM rail it settles. Omitted fields fall back to a
   * neutral placeholder rather than being dropped, because the field is required, not optional.
   */
  resource?: { url?: string; description?: string; mimeType?: string }
}

interface VerifyResponse {
  isValid: boolean
  invalidReason?: string
  invalidMessage?: string
  payer?: string
}
interface SettleResponse {
  success: boolean
  errorReason?: string
  errorMessage?: string
  payer?: string
  transaction: string
  network: string
}

/** JSON.stringify with a BigInt-safe replacer (mirrors coinbase's facilitator client). */
function safeStringify(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))
}

/** Map a facilitator's `invalidReason`/`errorReason` string to a PipRail VerifyErrorCode. */
function mapReason(reason: string | undefined): VerifyErrorCode {
  const r = (reason ?? '').toLowerCase()
  if (r.includes('signature')) return 'signature_invalid'
  if (r.includes('recipient')) return 'wrong_recipient'
  if (r.includes('value') || r.includes('amount')) return 'amount_too_low'
  if (r.includes('valid_before') || r.includes('valid_after') || r.includes('expired')) return 'payment_expired'
  if (r.includes('used') || r.includes('replay') || r.includes('nonce') || r.includes('transaction_state')) {
    return 'tx_already_used'
  }
  // insufficient_funds, paused, blacklisted, unknown → the payer can re-try after fixing → tx_reverted.
  return 'tx_reverted'
}

async function post(
  url: string,
  body: unknown,
  headers: Record<string, string>
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: safeStringify(body),
  })
  let json: unknown = null
  try {
    json = await res.json()
  } catch {
    /* non-JSON body */
  }
  return { status: res.status, json }
}

/**
 * Verify-then-settle a standard `exact` payment through a third-party facilitator.
 * Returns a {@link VerifyResult}: `{ ok:false, error }` for a client-fixable
 * facilitator rejection (verify isValid:false, or settle success:false) → 402;
 * `{ ok:true, receipt }` on a settled payment. THROWS {@link SettlementError} on a
 * transport/auth failure (non-200) — the gate replies 5xx, never a misleading 402.
 */
export async function settleViaFacilitator(input: SettleViaFacilitatorInput): Promise<VerifyResult> {
  const base = input.url.replace(/\/+$/, '')
  // x402 v1 spells the requirements `paymentRequirements`; v2 spells them `accepted` and adds a
  // required `resource`. Both are sent on a v2 body: the v1 key is what the older facilitators
  // read, the v2 keys are what a strict v2 facilitator demands, and neither side minds the extra.
  const v2 = input.x402Version >= 2
  const body = {
    x402Version: input.x402Version,
    paymentPayload: input.paymentPayload,
    paymentRequirements: input.paymentRequirements,
    ...(v2
      ? {
          accepted: input.paymentRequirements,
          resource: {
            url: input.resource?.url || 'https://piprail.com/x402/resource',
            description: input.resource?.description || 'Paid resource',
            mimeType: input.resource?.mimeType || 'application/json',
          },
        }
      : {}),
  }
  const auth = input.authHeaders ? await input.authHeaders() : {}

  // 1) /verify — a cheap, early reject before asking the facilitator to settle.
  let verify: { status: number; json: unknown }
  try {
    verify = await post(`${base}/verify`, body, auth)
  } catch (err) {
    throw new SettlementError(
      `exact settle (facilitator ${base}): /verify request failed (${err instanceof Error ? err.message : String(err)}).`,
      { cause: err }
    )
  }
  if (verify.status !== 200) {
    /*
     * Whose fault is it? That question decides whether the buyer sees a 402 or a 5xx, and
     * getting it wrong wastes somebody's time in a way they cannot diagnose.
     *
     *   400 / 422  the PAYLOAD is bad — a forged or malformed authorization. The buyer's
     *              problem, and only the buyer can fix it, so reject with the reason.
     *   401 / 403  the facilitator refused OUR credentials. The MERCHANT's misconfiguration;
     *              the buyer can do nothing but retry forever, so this stays a 5xx.
     *   404        the facilitator URL is wrong. Merchant's problem again.
     *   429        rate-limited, which really is retry-later.
     *   5xx / net  the facilitator is down.
     *
     * Only the first line is the buyer's. Answering 5xx for it told a buyer "our fault, try
     * again" about a payment that could never succeed, and showed in a merchant's metrics as
     * an outage they did not have.
     */
    if (verify.status === 400 || verify.status === 422) {
      const vr4 = (verify.json ?? {}) as VerifyResponse
      return {
        ok: false,
        error: mapReason(vr4.invalidReason),
        detail:
          `Facilitator rejected the payment payload (HTTP ${verify.status})` +
          `${vr4.invalidReason ? `: ${vr4.invalidReason}` : ''}` +
          `${vr4.invalidMessage ? ` — ${vr4.invalidMessage}` : ''}.`,
      }
    }
    throw new SettlementError(
      `exact settle (facilitator ${base}): /verify returned HTTP ${verify.status} (transport/auth error).`
    )
  }
  const vr = (verify.json ?? {}) as VerifyResponse
  if (vr.isValid === false) {
    return {
      ok: false,
      error: mapReason(vr.invalidReason),
      detail: `Facilitator rejected the payment: ${vr.invalidReason ?? 'invalid'}${vr.invalidMessage ? ` — ${vr.invalidMessage}` : ''}.`,
    }
  }

  // 2) /settle — the facilitator broadcasts + waits.
  let settle: { status: number; json: unknown }
  try {
    settle = await post(`${base}/settle`, body, auth)
  } catch (err) {
    throw new SettlementError(
      `exact settle (facilitator ${base}): /settle request failed (${err instanceof Error ? err.message : String(err)}).`,
      { cause: err }
    )
  }
  if (settle.status !== 200) {
    throw new SettlementError(
      `exact settle (facilitator ${base}): /settle returned HTTP ${settle.status} (transport/auth error).`
    )
  }
  const sr = (settle.json ?? {}) as SettleResponse
  if (!sr.success) {
    return {
      ok: false,
      error: mapReason(sr.errorReason),
      detail: `Facilitator settlement failed: ${sr.errorReason ?? 'unknown'}${sr.errorMessage ? ` — ${sr.errorMessage}` : ''}.`,
    }
  }

  const receipt: X402Receipt = {
    scheme: 'exact',
    success: true,
    network: input.receipt.network,
    transaction: sr.transaction,
    asset: input.receipt.asset,
    amount: input.receipt.amount,
    payer: sr.payer ?? input.payerHint ?? '',
    payTo: input.receipt.payTo,
    verifiedAt: new Date().toISOString(),
  }
  return { ok: true, receipt }
}

/**
 * Scheme/chain triage for an x402 challenge — a pure, never-throwing read that
 * tells an agent WHY a 402 might be unpayable: "wrong chain" vs "the scheme isn't
 * enabled" vs "no rail at all". Stops those three very different fixes from being
 * conflated into one opaque `NO_COMPATIBLE_ACCEPT`.
 *
 * PURE: imports only types (`./x402.js`, `./client.js`) — zero chain libraries,
 * zero I/O. Feed it a challenge you already parsed (`parseChallenge`) plus your
 * client's bound network + enabled schemes.
 */
import type { Caip2, X402Challenge } from './x402.js'
import type { PaymentScheme } from './client.js'

/** The verdict of a challenge triage — what's standing between you and paying. */
export type ChallengeVerdict =
  | 'PAYABLE_RAIL' // at least one rail is on your chain AND uses a scheme you've enabled
  | 'UNPAYABLE_SCHEME' // a rail is on your chain, but only via a scheme you haven't enabled
  | 'WRONG_CHAIN' // rails exist, but none on your chain
  | 'NO_RAIL' // the challenge offers no rails at all

export interface ChallengeTriage {
  /** Does any offered rail sit on the client's bound network? */
  onClientChain: boolean
  /** Does any rail on the client's network use an enabled scheme? */
  payableScheme: boolean
  /** The distinct schemes the challenge offers. */
  offeredSchemes: PaymentScheme[]
  /** The distinct networks the challenge offers. */
  offeredNetworks: Caip2[]
  /** The one-word verdict. */
  verdict: ChallengeVerdict
}

/**
 * Bucket `challenge.accepts[]` by (network === `opts.network`) and
 * (scheme ∈ `opts.schemes`) and return the verdict. Never throws.
 */
export function classifyChallenge(
  challenge: X402Challenge,
  opts: { network: Caip2; schemes: readonly PaymentScheme[] }
): ChallengeTriage {
  // Never throws (the documented contract): a nullish / shapeless challenge or opts — INCLUDING a
  // null/undefined ELEMENT inside accepts[] or a hostile getter/Proxy — must degrade to a verdict,
  // not a TypeError. Reachable wherever a FOREIGN 402's shape isn't guaranteed. Each rail is read
  // null-safe (`a?.scheme`), and the whole body is wrapped so any throwing accessor falls back.
  try {
    const accepts = Array.isArray(challenge?.accepts) ? challenge.accepts : []
    const network = opts?.network
    const schemes = opts?.schemes ?? []
    const offeredSchemes = [
      ...new Set(accepts.map((a) => a?.scheme).filter((s): s is PaymentScheme => s != null)),
    ]
    const offeredNetworks = [...new Set(accepts.map((a) => a?.network).filter((n) => n != null))]
    const onClientChain = accepts.some((a) => a?.network === network)
    const payableScheme = accepts.some(
      (a) => a?.network === network && schemes.includes(a?.scheme)
    )
    const verdict: ChallengeVerdict =
      accepts.length === 0
        ? 'NO_RAIL'
        : payableScheme
          ? 'PAYABLE_RAIL'
          : onClientChain
            ? 'UNPAYABLE_SCHEME'
            : 'WRONG_CHAIN'
    return { onClientChain, payableScheme, offeredSchemes, offeredNetworks, verdict }
  } catch {
    return {
      onClientChain: false,
      payableScheme: false,
      offeredSchemes: [],
      offeredNetworks: [],
      verdict: 'NO_RAIL',
    }
  }
}

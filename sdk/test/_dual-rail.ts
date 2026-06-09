/**
 * Test helper: narrow a (possibly dual-advertised) challenge's `accepts[]` to its
 * `onchain-proof` rails — what the pre-exact tests exercise. Since `accepts` is now
 * the `X402AnyAccept` union (onchain-proof OR standard `exact`), reading the
 * onchain-proof-specific `extra.nonce` needs a narrowing. The gates in these tests
 * carry no `exact` rail, so this is an identity filter that just satisfies the type.
 */
import type { X402Challenge, X402AcceptEntry } from '../src/x402.js'

export function proofAccepts(c: X402Challenge): X402AcceptEntry[] {
  return c.accepts.filter((a): a is X402AcceptEntry => a.scheme === 'onchain-proof')
}

export function firstProof(c: X402Challenge): X402AcceptEntry {
  const a = proofAccepts(c)[0]
  if (!a) throw new Error('test helper: challenge offered no onchain-proof accept')
  return a
}

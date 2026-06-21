import type { ChainFamily } from '../drivers/types.js'

/**
 * Family-correct "how to check whether this `exact` payment already settled" hint — used in the
 * `PaymentTimeoutError` message thrown when the authorization was submitted but no response came
 * back, so the agent can verify on-chain before re-presenting (and never re-pay).
 *
 * The single-use marker differs per family: EVM exposes it as an on-chain `authorizationState`
 * read; the non-EVM rails key off the broadcast transaction itself (a duplicate signature, an
 * atomic-group id, a sequence number, an access-key nonce). A message that names the EVM call is
 * wrong on every other family — so this returns the right phrasing per family.
 *
 * Stays in the chain-agnostic layer by design: pure descriptive text keyed on the abstract
 * `ChainFamily`, names no chain library, and falls back to a family-neutral marker for any family
 * without a bespoke note (so a future `exact` family degrades gracefully rather than misleads).
 *
 * `payerFrom` is the buyer address (the EVM `from`, or the NEAR account id); `nonce` is the
 * authorization nonce already surfaced as the error's `ref`.
 */
export function exactSettleCheckHint(family: ChainFamily, payerFrom: string, nonce: string): string {
  switch (family) {
    case 'evm':
      return `the EIP-3009 \`authorizationState(${payerFrom}, ${nonce})\` (or, on the Permit2 method, the Permit2 nonce bitmap)`
    case 'solana':
      return `the buyer's transaction signature (a duplicate signature is the chain's own replay guard; plus the SPL-Memo nonce when present)`
    case 'algorand':
      return `the atomic group / transaction id`
    case 'aptos':
      return `the sender's account sequence number`
    case 'near':
      return `the access-key nonce (\`${nonce}\`)`
    default:
      return `the single-use marker (\`ref=${nonce}\`)`
  }
}

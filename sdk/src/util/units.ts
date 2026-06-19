/**
 * Chain-agnostic amount math. Keeps the protocol layer free of any
 * chain SDK (viem / web3.js) for a pure string→bigint conversion.
 */

/**
 * Sane upper bound on a token's decimals. The deepest real token is NEAR's yoctoNEAR
 * at 24dp; every stablecoin is ≤ 18. We cap WELL above that (no real token comes close)
 * purely as a DoS guard: without it, a hostile 402 stating an absurd `decimals` (e.g. 1e9
 * for an unrecognised token under `allowUnknownTokens`) would make `padStart`/`padEnd`
 * below allocate a multi-GB string — an out-of-memory crash. 100 is generous headroom for
 * any conceivable token while keeping the worst-case string tiny.
 */
export const MAX_DECIMALS = 100

/**
 * Guard the `decimals` argument shared by the conversions below. A token's decimals is
 * always a non-negative safe integer (and, defensively, ≤ {@link MAX_DECIMALS}), so a
 * negative / fractional / NaN / absurdly-large value is a config bug (a malformed preset)
 * or a hostile server — either of which would otherwise corrupt the bigint math via
 * `padStart` / `slice` / `padEnd`, or exhaust memory. Fail loudly instead.
 * (Decimals-hardening contributed by @samsamtrum, #25; upper-bound DoS guard added in 2.9.0.)
 */
function assertValidDecimals(decimals: number, fn: string): void {
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS) {
    throw new Error(
      `${fn}: decimals must be a non-negative integer ≤ ${MAX_DECIMALS} (got ${decimals}).`
    )
  }
}

/**
 * Parse a decimal amount string into base units.
 *   parseUnits('0.05', 6)  → 50000n
 *   parseUnits('1', 18)    → 1000000000000000000n
 *
 * Throws on a malformed amount or more fractional digits than `decimals`.
 */
export function parseUnits(value: string, decimals: number): bigint {
  assertValidDecimals(decimals, 'parseUnits')
  if (!/^\d+(\.\d+)?$/.test(value)) {
    throw new Error(`parseUnits: "${value}" is not a non-negative decimal amount.`)
  }
  const [whole, frac = ''] = value.split('.')
  if (frac.length > decimals) {
    throw new Error(
      `parseUnits: "${value}" has more than ${decimals} decimal places.`
    )
  }
  const fracPadded = frac.padEnd(decimals, '0')
  return BigInt(whole + fracPadded)
}

/**
 * Like parseUnits, but TRUNCATES (floors) fractional digits finer than the
 * token supports instead of throwing. Used for spend-policy caps: a budget of
 * '0.001' on a 2-decimal token floors to 0 base units (so nothing is affordable
 * — the strict, safe direction for a ceiling), never an exception mid-payment.
 * Still rejects a malformed / negative amount (a real config error).
 */
export function floorUnits(value: string, decimals: number): bigint {
  assertValidDecimals(decimals, 'floorUnits')
  if (!/^\d+(\.\d+)?$/.test(value)) {
    throw new Error(`floorUnits: "${value}" is not a non-negative decimal amount.`)
  }
  const [whole, frac = ''] = value.split('.')
  const fracTrunc = frac.slice(0, decimals).padEnd(decimals, '0')
  return BigInt(whole + fracTrunc)
}

/**
 * Format base units back into a decimal string — the inverse of parseUnits.
 *   formatUnits(50000n, 6)               → '0.05'
 *   formatUnits(1000000000000000000n, 18) → '1'
 * Trailing zeros in the fractional part are trimmed; an integer has no point.
 */
export function formatUnits(value: bigint, decimals: number): string {
  assertValidDecimals(decimals, 'formatUnits')
  const negative = value < 0n
  const digits = (negative ? -value : value).toString().padStart(decimals + 1, '0')
  const whole = digits.slice(0, digits.length - decimals)
  const frac = digits.slice(digits.length - decimals).replace(/0+$/, '')
  return `${negative ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`
}

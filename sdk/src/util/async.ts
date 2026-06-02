/**
 * Tiny chain-agnostic async helpers shared by the driver confirm/poll loops, so
 * the same `delay()` isn't redefined in every driver.
 */

/** Resolve after `ms` milliseconds. */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

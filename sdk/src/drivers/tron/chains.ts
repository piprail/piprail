/**
 * ── TRON SECTION: presets ──
 * Tron mainnet with its canonical USD₮ (TRC-20) pre-filled, so a developer never
 * pastes a contract. Tron is the single largest stablecoin-payment rail on earth
 * — it holds ~45% of all USDT in circulation — so this is the biggest reach win
 * in the lineup.
 *
 * **No native USDC on Tron.** Circle discontinued minting on Tron (Feb 2024) and
 * Tron is absent from Circle's contract-address list; the only USDC is a
 * third-party JustCrypto bridge, so it is intentionally NOT shipped (pass it as a
 * custom `{ address, decimals }` if you must). Ships USD₮ only, mirroring TON's
 * "USD₮ only" decision.
 *
 * **Native TRX IS supported** (`token: 'native'`, 6dp) via **digest-binding** — a plain
 * `TransferContract`, verified by txid + a recency window + the gate's single-use set
 * (exactly like the TRC-20 path, just reading the tx's TransferContract instead of a
 * Transfer event log). TRX is the volatile gas coin, so for stable pricing pay in USD₮;
 * native is there for completeness (native coin is now a payment asset on every family).
 * USD₮ remains the default — native USDC doesn't exist on Tron (pass a custom TRC-20).
 *
 * USDT contract verified live on mainnet before shipping (TronGrid:
 * `decimals() = 6`, `symbol() = "USDT"`). The contract's 20-byte hex (the form
 * that appears in Transfer-event logs) is `a614f803b6fd780986a42c78ec9c7f77e6ded13c`.
 *
 * CAIP-2 `tron:mainnet` is an internal id (Tron isn't in the official x402 CAIP-2
 * registry); zero interop impact since PipRail self-verifies.
 */

export interface TrcTokenInfo {
  /** TRC-20 contract, Base58 (T…). */
  address: string
  decimals: number
  symbol: string
}

export interface TronPreset {
  caip2: `tron:${string}`
  /** Public default RPC (TronGrid) — rate-limited; pass your own in production. */
  defaultRpc: string
  tokens: Record<string, TrcTokenInfo>
}

/** Native TRX is 6 decimals (1 sun = 1e-6 TRX) — a built-in payment asset via
 *  `token: 'native'` (digest-bound; see the section note). */
export const TRX_DECIMALS = 6

export const TRON_MAINNET: TronPreset = {
  caip2: 'tron:mainnet',
  defaultRpc: 'https://api.trongrid.io',
  tokens: {
    // USD₮ (Tether) — the dominant stablecoin on Tron. Contract + 6 decimals +
    // symbol verified live on-chain (TronGrid triggerconstantcontract) before shipping.
    USDT: {
      address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
      decimals: 6,
      symbol: 'USDT',
    },
  },
}

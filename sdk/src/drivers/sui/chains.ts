/**
 * ── SUI SECTION: presets ──
 * Sui mainnet with its canonical native Circle USDC pre-filled. Sui is a Move L1
 * with sub-second (~400ms) finality; coins are owned objects identified by a
 * CoinType (a `package::module::TYPE` path), not a contract address.
 *
 * **USDC only — no native USDT on Sui** (only Wormhole-bridged, not Circle/Tether-
 * redeemable), so it's intentionally absent (mirrors TON/Tron single-token
 * presets); pass a custom coin via `{ coinType, decimals }`.
 *
 * The USDC coin type + 6 decimals were verified live on mainnet
 * (`suix_getCoinMetadata`) before shipping. CAIP-2 `sui:mainnet` matches the
 * official x402 mainnet id.
 *
 * Note on "gasless": Sui has a protocol-level gasless stablecoin path (the
 * Address Balances API, mainnet 2026) — genuinely gas-free, NO sponsor/relayer.
 * This driver ships the STANDARD self-gas `Coin<USDC>` transfer (always
 * available, verified by tx digest); the gasless path is a different tx shape
 * and a future enhancement — so don't market THIS path as "gasless".
 */

export interface SuiCoinInfo {
  /** Fully-qualified coin type, e.g. `0x…::usdc::USDC`. */
  coinType: string
  decimals: number
  symbol: string
}

export interface SuiPreset {
  caip2: `sui:${string}`
  /** Public default fullnode — rate-limited; pass your own `rpcUrl` in production. */
  defaultRpc: string
  tokens: Record<string, SuiCoinInfo>
}

/** Native SUI is 9 decimals (MIST). */
export const SUI_DECIMALS = 9

/** Native SUI ticker. */
export const SUI_SYMBOL = 'SUI'

/** The native SUI coin type — how it appears in balance changes. */
export const SUI_NATIVE_COINTYPE = '0x2::sui::SUI'

export const SUI_MAINNET: SuiPreset = {
  caip2: 'sui:mainnet',
  defaultRpc: 'https://fullnode.mainnet.sui.io:443',
  tokens: {
    // Circle USDC — coin type + 6 decimals verified live on mainnet
    // (suix_getCoinMetadata) before shipping. No native USDT on Sui.
    USDC: {
      coinType: '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC',
      decimals: 6,
      symbol: 'USDC',
    },
  },
}

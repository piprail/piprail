/**
 * ── APTOS SECTION: presets ──
 * Aptos mainnet with its canonical native Circle USDC + native Tether USD₮
 * pre-filled. Aptos is a Move L1 with sub-second (~sub-second) finality; modern
 * assets are **Fungible Assets (FA)**, identified by a metadata OBJECT address
 * (a 0x… address), not a legacy `Coin<T>` type.
 *
 * **Both stablecoins are native** (the only Move L1 with both): Circle-native
 * USDC and Tether-native USD₮. Both FA metadata addresses + 6 decimals were
 * verified live on mainnet (`0x1::fungible_asset::Metadata` read) before
 * shipping. CAIP-2 `aptos:1` matches the official x402 mainnet id (`aptos:2` =
 * testnet); presets are mainnet-only.
 *
 * Template B (digest-bound, like Sui/EVM/Solana): the proof ref is the tx hash;
 * verify() re-derives the watched recipient store from the trusted `accept`
 * (never the client ref). Persistent isUsed/markUsed + a tight maxTimeoutSeconds
 * are load-bearing for multi-instance deployments (README §3a).
 */

export interface AptosCoinInfo {
  /** The Fungible Asset metadata object address (e.g. `0xbae2…6f3b`). */
  metadata: string
  decimals: number
  symbol: string
}

export interface AptosPreset {
  caip2: `aptos:${string}`
  /** Public default fullnode (REST) — rate-limited; pass your own `rpcUrl` in production. */
  defaultRpc: string
  tokens: Record<string, AptosCoinInfo>
}

/** Native APT is 8 decimals (octas). */
export const APT_DECIMALS = 8

/** Native APT ticker. */
export const APT_SYMBOL = 'APT'

/**
 * APT's paired Fungible Asset metadata object — the native coin AS an FA. Native
 * APT payments transfer this FA (so they emit the same `0x1::fungible_asset::Deposit`
 * event the stablecoins do), letting one pay/verify path cover native + USDC + USDT.
 */
export const APT_FA_METADATA = '0xa'

export const APTOS_MAINNET: AptosPreset = {
  caip2: 'aptos:1',
  defaultRpc: 'https://fullnode.mainnet.aptoslabs.com/v1',
  tokens: {
    // Circle USDC — FA metadata + 6 decimals verified live on mainnet
    // (0x1::fungible_asset::Metadata → symbol "USDC", decimals 6) before shipping.
    USDC: {
      metadata: '0xbae207659db88bea0cbead6da0ed00aac12edcdda169e591cd41c94180b46f3b',
      decimals: 6,
      symbol: 'USDC',
    },
    // Tether USD₮ — use the FA *metadata* address (NOT the issuer/creator address
    // 0xf73e…73cb). Verified live (Metadata → name "Tether USD", symbol "USDt", decimals 6).
    USDT: {
      metadata: '0x357b0b74bc833e95a115ad22604854d6b0fca151cecd94111770e5d6ffc9dc2b',
      decimals: 6,
      symbol: 'USDT',
    },
  },
}

/**
 * ── ALGORAND SECTION: presets ──
 * Algorand mainnet with its canonical native Circle USDC pre-filled. Algorand is
 * a pure-PoS, payments-focused L1: ~instant single-step finality (~3s, no reorgs)
 * and sub-cent fees. Assets are ASAs (Algorand Standard Assets) identified by a
 * numeric **asset id**, not a contract address; native ALGO and ASAs both transfer
 * in integer base units (like EVM), and every transaction carries an arbitrary
 * **note field (up to 1KB)** — which is where the challenge nonce rides.
 *
 * **USDC-only.** Tether lists Algorand under "Deprecated Asset Protocols" — USDT
 * on Algorand is end-of-life, so it fails the issuer-native rule and is omitted
 * (a caller can still pass it as a custom ASA). Native ALGO is always available.
 *
 * The USDC ASA + 6 decimals were verified live on mainnet (algod `/v2/assets/31566704`
 * → unit-name "USDC", decimals 6, creator/reserve = Circle's 2UEQ… account,
 * url centre.io/usdc) before shipping.
 *
 * CAIP-2 is not assigned by the x402 spec for Algorand → use the official
 * `algorand:<genesis-hash-prefix>` form (mainnet); zero interop impact (we self-verify).
 */

export interface AlgorandAssetInfo {
  /** The ASA (Algorand Standard Asset) id, e.g. 31566704 for USDC. */
  assetId: number
  decimals: number
  symbol: string
}

export interface AlgorandPreset {
  caip2: `algorand:${string}`
  /** Public default algod (submit/params) — rate-limited; pass your own `rpcUrl` in production. */
  defaultAlgod: string
  /** Public default indexer (history/verify) — used to read the merchant's inbound transfers. */
  defaultIndexer: string
  tokens: Record<string, AlgorandAssetInfo>
}

/** Native ALGO is 6 decimals (microAlgos). */
export const ALGO_DECIMALS = 6

/** Native ALGO ticker. */
export const ALGO_SYMBOL = 'ALGO'

export const ALGORAND_MAINNET: AlgorandPreset = {
  caip2: 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73k',
  defaultAlgod: 'https://mainnet-api.algonode.cloud',
  defaultIndexer: 'https://mainnet-idx.algonode.cloud',
  tokens: {
    // Circle USDC — ASA id + 6 decimals verified live on mainnet algod
    // (/v2/assets/31566704 → unit-name "USDC", decimals 6, creator = Circle) before shipping.
    // USDC-only: Tether deprecated USDT on Algorand, so it's intentionally omitted.
    USDC: { assetId: 31566704, decimals: 6, symbol: 'USDC' },
  },
}

/** Canonical asset id used across the wire: the ASA id as a string (or 'native' for ALGO). */
export function algorandAssetId(assetId: number): string {
  return String(assetId)
}

/** Parse a wire asset id back into an ASA id. Returns null for 'native'/malformed. */
export function parseAlgorandAssetId(asset: string): number | null {
  if (asset === 'native') return null
  if (!/^\d+$/.test(asset)) return null
  const n = Number(asset)
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

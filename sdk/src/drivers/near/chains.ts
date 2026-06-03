/**
 * ── NEAR SECTION: presets ──
 * NEAR mainnet with its canonical native stablecoins pre-filled. NEAR is the
 * "user-owned AI" chain (co-founder Illia Polosukhin co-authored the Transformer
 * paper); tokens are NEP-141 fungible tokens identified by a contract ACCOUNT id
 * (named like `usdt.tether-token.near`, or a 64-hex address), not a 0x contract.
 *
 * Ships **USDC + USDT, both native** (verified live via `ft_metadata`, 6dp):
 *   - USDC = Circle's native `17208628…36133a1` — NOT the bridged
 *     `…factory.bridge.near` (USDC.e, Rainbow-Bridge, not Circle-issued).
 *   - USDT = Tether's native `usdt.tether-token.near` (on-chain symbol "USDt").
 *
 * **Native NEAR IS supported** (`token: 'native'`) via **digest-binding** — a plain
 * `Transfer`, verified by tx hash + recency + the gate's single-use set (the NEP-141
 * path stays memo-bound). Native needs **no `storage_deposit`** and even creates a
 * fresh implicit recipient — the zero-setup NEAR path. (NEAR is a volatile gas coin,
 * so for stable pricing pay in USDC/USDT; for no-setup flows, native is ideal.)
 *
 * CAIP-2 `near:mainnet` is an internal id (NEAR isn't in the official x402
 * registry); zero interop impact since PipRail self-verifies.
 */

export interface NearFtInfo {
  /** NEP-141 contract account id. */
  contractId: string
  decimals: number
  symbol: string
}

export interface NearPreset {
  caip2: `near:${string}`
  /** Public default RPC (FastNEAR) — rate-limited; pass your own in production. */
  defaultRpc: string
  tokens: Record<string, NearFtInfo>
}

/** Native NEAR is 24 decimals (yoctoNEAR) — used both for gas estimates and, now, as a
 *  payment asset via `token: 'native'` (digest-bound; see the section note). */
export const NEAR_DECIMALS = 24

export const NEAR_MAINNET: NearPreset = {
  caip2: 'near:mainnet',
  defaultRpc: 'https://free.rpc.fastnear.com',
  tokens: {
    // Circle USDC — native (NOT the .factory.bridge.near bridge). Contract + 6dp
    // verified live via ft_metadata before shipping.
    USDC: {
      contractId: '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
      decimals: 6,
      symbol: 'USDC',
    },
    // Tether USDt — native (Tether's official tether-token.near account). On-chain
    // symbol is "USDt"; contract + 6dp verified live via ft_metadata before shipping.
    USDT: {
      contractId: 'usdt.tether-token.near',
      decimals: 6,
      symbol: 'USDT',
    },
  },
}

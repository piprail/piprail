/**
 * ── STELLAR SECTION: presets ──
 * Stellar mainnet (pubnet) with its canonical native USDC + EURC pre-filled, so
 * a developer never pastes an issuer. Stellar is payment-native: ~5s single-step
 * finality, built-in transaction memos, and assets identified by CODE + ISSUER
 * (not a contract address).
 *
 * Asset precision on Stellar is universally **7 decimal places** (1 unit = 1e-7);
 * there is no per-asset `decimals` like ERC-20 — USDC, EURC and native XLM are
 * all 7dp. Amounts still cross the wire as base units (`parseUnits(human, 7)`);
 * the driver converts to/from Stellar's human-decimal strings at the edges.
 *
 * Both issuers were verified live on Horizon (`/assets`) before shipping; the
 * **testnet** USDC issuer (`GBBD47IF…`) is deliberately NOT used (several
 * secondary sources mislabel it as mainnet).
 *
 * CAIP-2 `stellar:pubnet` matches the official x402 mainnet id.
 */

export interface StellarAssetInfo {
  /** Issuing account (G… address). */
  issuer: string
  /** Asset code, e.g. 'USDC'. */
  code: string
  /** Always 7 on Stellar. */
  decimals: number
  symbol: string
}

export interface StellarPreset {
  caip2: `stellar:${string}`
  /** Mainnet network passphrase — signed into every transaction. */
  passphrase: string
  /** Public default Horizon endpoint — rate-limited; pass your own in production. */
  defaultRpc: string
  tokens: Record<string, StellarAssetInfo>
}

/** Stellar assets are universally 7 decimal places (1 stroop = 1e-7 XLM). */
export const STELLAR_DECIMALS = 7

/** Native XLM (Lumens) ticker. */
export const XLM_SYMBOL = 'XLM'

/** Mainnet network passphrase — exact string, signed into every transaction. */
export const STELLAR_PASSPHRASE = 'Public Global Stellar Network ; September 2015'

export const STELLAR_MAINNET: StellarPreset = {
  caip2: 'stellar:pubnet',
  passphrase: STELLAR_PASSPHRASE,
  defaultRpc: 'https://horizon.stellar.org',
  tokens: {
    // Circle USDC — issuer + code verified live on Horizon /assets before shipping.
    // (Mainnet issuer; NOT the testnet GBBD47IF… one.)
    USDC: {
      issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
      code: 'USDC',
      decimals: STELLAR_DECIMALS,
      symbol: 'USDC',
    },
    // Circle EURC — issuer + code verified live on Horizon /assets before shipping.
    EURC: {
      issuer: 'GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2',
      code: 'EURC',
      decimals: STELLAR_DECIMALS,
      symbol: 'EURC',
    },
  },
}

/** Canonical asset id used across the wire: `CODE:ISSUER` (or `'native'` for XLM). */
export function stellarAssetId(code: string, issuer: string): string {
  return `${code}:${issuer}`
}

/** Parse a `CODE:ISSUER` asset id back into parts. Returns null for `'native'`/malformed. */
export function parseStellarAssetId(
  asset: string
): { code: string; issuer: string } | null {
  if (asset === 'native') return null
  const i = asset.indexOf(':')
  if (i <= 0 || i === asset.length - 1) return null
  return { code: asset.slice(0, i), issuer: asset.slice(i + 1) }
}

/**
 * ── XRPL SECTION: presets ──
 * XRP Ledger (XRPL) mainnet with its canonical native USDC + RLUSD pre-filled,
 * so a developer never pastes an issuer. XRPL is payment-native: ~3–5s
 * single-step finality (no reorgs), a built-in DestinationTag + Memo, and
 * issued assets identified by CURRENCY + ISSUER (not a contract address).
 *
 * Two precision models live on XRPL:
 *   - native XRP is fixed 6-dp "drops" (1 drop = 1e-6 XRP) — integer base units.
 *   - issued currencies (USDC, RLUSD) are NOT fixed-decimal: they are float
 *     values carried as decimal STRINGS (`value: "0.05"`), up to 15 significant
 *     digits. There is no on-ledger `decimals`. So the `decimals` below is the
 *     SDK's chosen base-unit SCALING convention (6 dp — the canonical stablecoin
 *     precision, ample for micropayments), used only to turn the human amount
 *     into `accept.amount` base units and to compare delivered amounts; it is
 *     NOT an on-ledger fixed precision. Amounts still cross the wire as base
 *     units; the driver converts to/from XRPL's decimal strings at the edges.
 *
 * Both issuers were verified live on mainnet before shipping: each issuer's
 * on-ledger `Domain` was read (USDC → `https://circle.com`, RLUSD →
 * `https://ripple.com/`) and `gateway_balances` confirmed each issues its
 * currency code. 4+ char currency codes MUST use the 160-bit hex form (the
 * 3-char ASCII form only fits ≤3 chars) — both USDC and RLUSD do.
 *
 * CAIP-2 `xrpl:0` is an internal id (XRPL isn't in the official x402 CAIP-2
 * registry); zero interop impact since PipRail self-verifies.
 */

export interface XrplAssetInfo {
  /** Issuing account (r… address). */
  issuer: string
  /** 160-bit currency code as a 40-char hex string (USDC/RLUSD are 4+ chars). */
  currencyHex: string
  /** SDK base-unit scaling convention (XRPL issued amounts are decimal strings). */
  decimals: number
  symbol: string
}

export interface XrplPreset {
  caip2: `xrpl:${string}`
  /** Public default JSON-RPC endpoint — rate-limited; pass your own in production. */
  defaultRpc: string
  tokens: Record<string, XrplAssetInfo>
}

/** Native XRP is 6 decimals — drops (1 drop = 1e-6 XRP). */
export const XRP_DECIMALS = 6

/** Native XRP ticker. */
export const XRP_SYMBOL = 'XRP'

export const XRPL_MAINNET: XrplPreset = {
  caip2: 'xrpl:0',
  // Public community cluster (serves HTTPS JSON-RPC). Not for sustained
  // business use — pass your own `rpcUrl` in production.
  defaultRpc: 'https://xrplcluster.com/',
  tokens: {
    // Circle USDC — issuer Domain (`https://circle.com`) + currency code verified
    // live on mainnet (gateway_balances) before shipping.
    USDC: {
      issuer: 'rGm7WCVp9gb4jZHWTEtGUr4dd74z2XuWhE',
      currencyHex: '5553444300000000000000000000000000000000',
      decimals: 6,
      symbol: 'USDC',
    },
    // Ripple RLUSD — issuer Domain (`https://ripple.com/`) + currency code
    // verified live on mainnet before shipping. Note: the RLUSD issuer sets
    // requireDestinationTag, so payments always carry a DestinationTag (set below).
    RLUSD: {
      issuer: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De',
      currencyHex: '524C555344000000000000000000000000000000',
      decimals: 6,
      symbol: 'RLUSD',
    },
  },
}

/** Canonical asset id used across the wire: `currencyHex:issuer` (or `'native'` for XRP). */
export function xrplAssetId(currencyHex: string, issuer: string): string {
  return `${currencyHex}:${issuer}`
}

/**
 * Is this asset id the native coin? THE ONE OWNER of that question for XRPL.
 *
 * PipRail writes the native coin as `'native'` on every family, but the XRPL x402 web writes it as
 * the literal **`'XRP'`** — all 863 native rails in the CDP Bazaar do, and a live probe of eight
 * independent merchants found no other spelling. Every read path has to accept both, because
 * missing one is invisible: the rail is silently dropped and the agent hears "no compatible accept"
 * on a chain it fully supports. (`describeAsset` missed it, then `recipientReady` demanded a
 * trustline for a coin that cannot have one — two separate live failures from the same gap.)
 *
 * We still EMIT `'native'`; this is parse-side tolerance only.
 */
export function isXrpNative(asset: string): boolean {
  return asset === 'native' || asset === 'XRP'
}

/** Parse a `currencyHex:issuer` asset id back into parts. Null for the native coin/malformed. */
export function parseXrplAssetId(
  asset: string
): { currencyHex: string; issuer: string } | null {
  if (isXrpNative(asset)) return null
  const i = asset.indexOf(':')
  if (i <= 0 || i === asset.length - 1) return null
  return { currencyHex: asset.slice(0, i), issuer: asset.slice(i + 1) }
}

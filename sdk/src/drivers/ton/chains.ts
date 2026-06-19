/**
 * ── TON SECTION: presets ──
 * TON (The Open Network / Telegram) mainnet with its canonical USD₮ jetton
 * pre-filled, so a developer never pastes a jetton master address.
 *
 * Native **USDC does not exist on TON** — Circle doesn't issue it there (its
 * canonical chain list omits TON; ton.org lists only USD₮ and USDe). So USDC is
 * intentionally absent; for USDe / bridged tokens pass a custom jetton via
 * `{ master, decimals }`.
 *
 * The CAIP-2 id uses the canonical `tvm` namespace + TON's network global id
 * (`tvm:-239` = mainnet) per the chain-agnostic registry (which has no `ton`
 * namespace) and the merged foundation TON exact scheme. The legacy `ton:-239`
 * id is still accepted on parse (see `LEGACY_CAIP2_ALIAS` in indexes.ts).
 */

export interface TonJettonInfo {
  /** Jetton master (friendly EQ… address). */
  master: string
  decimals: number
  symbol: string
}

export interface TonPreset {
  caip2: `tvm:${string}`
  /** Public default RPC — keyless toncenter, rate-limited. Pass your own
   * `rpcUrl` (and an API key in the URL/endpoint) in production. */
  defaultRpc: string
  tokens: Record<string, TonJettonInfo>
}

/**
 * The native coin's display symbol. The token was **renamed Toncoin → Gram** (ticker
 * `TON` → `GRAM`) by a TON community governance vote, live **2026-06-15** — a
 * presentation-layer rename of the *token only*. The blockchain is still **The Open
 * Network (TON)**: the CAIP-2 network id stays `tvm:-239`, addresses/contracts/jettons
 * are unchanged (no migration), and `chain: 'ton'` + `token: 'native'` select it exactly
 * as before. We surface the current ticker `GRAM` as the native symbol; nothing else moves.
 */
export const TON_NATIVE_SYMBOL = 'GRAM'

/** Native Gram (formerly Toncoin) is 9 decimals — nanoton. (Distinct from USD₮'s 6.) */
export const TON_DECIMALS = 9

export const TON_MAINNET: TonPreset = {
  caip2: 'tvm:-239',
  defaultRpc: 'https://toncenter.com/api/v2/jsonRPC',
  tokens: {
    // USD₮ (Tether) — native, dominant stablecoin on TON. Master + 6 decimals
    // verified on-chain (tonapi + toncenter) before shipping.
    USDT: {
      master: 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs',
      decimals: 6,
      symbol: 'USDT',
    },
  },
}

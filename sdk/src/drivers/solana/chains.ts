/**
 * ── SOLANA SECTION: presets ──
 * Solana mainnet with its canonical USDC mint pre-filled, so a developer
 * never pastes a mint address. The CAIP-2 id uses the cluster genesis hash
 * (truncated to 32 chars) per the chain-agnostic standard.
 */

export interface SolanaTokenInfo {
  mint: string
  decimals: number
  symbol: string
}

export interface SolanaPreset {
  caip2: `solana:${string}`
  /** Public default RPC — rate-limited; pass your own `rpcUrl` in production. */
  defaultRpc: string
  tokens: Record<string, SolanaTokenInfo>
}

/** SOL is 9 decimals. */
export const SOL_DECIMALS = 9

export const SOLANA_MAINNET: SolanaPreset = {
  caip2: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
  defaultRpc: 'https://api.mainnet-beta.solana.com',
  tokens: {
    USDC: {
      mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      decimals: 6,
      symbol: 'USDC',
    },
    USDT: {
      mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
      decimals: 6,
      symbol: 'USDT',
    },
  },
}

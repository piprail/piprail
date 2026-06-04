// The built-in chains, ordered by prominence — the biggest networks first
// (Ethereum, then the marquee non-EVM L1s Solana/TON/Tron/NEAR/Sui, then the
// payment-native Stellar/XRPL), then the major EVM chains, then the rest.
// `tokens` drives the stablecoin badges on each chain card.
// Mirrors the SDK's built-in registry (19 EVM mainnets + Solana + TON + Tron +
// NEAR + Sui + Aptos + Algorand + Stellar + XRPL).
export interface ChainEntry {
  name: string
  slug: string
  tokens: string[]
}

export const chains: ChainEntry[] = [
  { name: 'Ethereum', slug: 'ethereum', tokens: ['usdc', 'usdt'] },
  { name: 'Solana', slug: 'solana', tokens: ['usdc', 'usdt'] },
  { name: 'TON', slug: 'ton', tokens: ['usdt'] },
  { name: 'Tron', slug: 'tron', tokens: ['usdt'] },
  { name: 'NEAR', slug: 'near', tokens: ['usdc', 'usdt'] },
  { name: 'Sui', slug: 'sui', tokens: ['usdc'] },
  { name: 'Aptos', slug: 'aptos', tokens: ['usdc', 'usdt'] },
  { name: 'Algorand', slug: 'algorand', tokens: ['usdc'] },
  { name: 'Stellar', slug: 'stellar', tokens: ['usdc', 'eurc'] },
  { name: 'XRP Ledger', slug: 'xrpl', tokens: ['usdc', 'rlusd'] },
  { name: 'Base', slug: 'base', tokens: ['usdc'] },
  { name: 'BNB Chain', slug: 'bnb', tokens: ['usdc', 'usdt'] },
  { name: 'Arbitrum', slug: 'arbitrum', tokens: ['usdc', 'usdt'] },
  { name: 'Polygon', slug: 'polygon', tokens: ['usdc', 'usdt'] },
  { name: 'Optimism', slug: 'optimism', tokens: ['usdc', 'usdt'] },
  { name: 'Avalanche', slug: 'avalanche', tokens: ['usdc', 'usdt'] },
  { name: 'HyperEVM', slug: 'hyperevm', tokens: ['usdc'] },
  { name: 'Monad', slug: 'monad', tokens: ['usdc'] },
  { name: 'Mantle', slug: 'mantle', tokens: ['usdc', 'usdt'] },
  { name: 'Linea', slug: 'linea', tokens: ['usdc', 'usdt'] },
  { name: 'Scroll', slug: 'scroll', tokens: ['usdc', 'usdt'] },
  { name: 'zkSync Era', slug: 'zksync', tokens: ['usdc', 'usdt'] },
  { name: 'Celo', slug: 'celo', tokens: ['usdc', 'usdt'] },
  { name: 'Sonic', slug: 'sonic', tokens: ['usdc', 'usdt'] },
  { name: 'Unichain', slug: 'unichain', tokens: ['usdc', 'usdt'] },
  { name: 'World Chain', slug: 'worldchain', tokens: ['usdc'] },
  { name: 'Sei', slug: 'sei', tokens: ['usdc'] },
  { name: 'Injective', slug: 'injective', tokens: ['usdc', 'usdt'] },
]

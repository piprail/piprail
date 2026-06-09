// The built-in chains, ordered by prominence — the biggest networks first
// (Ethereum, then the marquee non-EVM L1s Solana/TON/Tron/NEAR/Sui, then the
// payment-native Stellar/XRPL), then the major EVM chains, then the rest.
// `tokens` drives the stablecoin badges on each chain card.
// `family` groups the catalog (every EVM chain shares one driver); `setup` is the
// one-time recipient caveat where a chain has one (omitted = zero-setup).
// Mirrors the SDK's built-in registry (20 EVM mainnets + Solana + TON + Tron +
// NEAR + Sui + Aptos + Algorand + Stellar + XRPL).
export interface ChainEntry {
  name: string
  slug: string
  tokens: string[]
  family: string
  /** One-time setup caveat (recipient-side), where the chain has one. */
  setup?: string
}

export const chains: ChainEntry[] = [
  { name: 'Ethereum', slug: 'ethereum', tokens: ['usdc', 'usdt', 'eurc'], family: 'EVM' },
  { name: 'Solana', slug: 'solana', tokens: ['usdc', 'usdt'], family: 'Solana' },
  { name: 'TON', slug: 'ton', tokens: ['usdt'], family: 'TON', setup: 'Needs a free API-keyed RPC (a toncenter key folded into rpcUrl). Ships USD₮ — there is no native USDC on TON.' },
  { name: 'Tron', slug: 'tron', tokens: ['usdt'], family: 'Tron', setup: 'Pays USD₮ or native TRX; gas is real TRX. No native USDC exists on Tron.' },
  { name: 'NEAR', slug: 'near', tokens: ['usdc', 'usdt'], family: 'NEAR', setup: 'Native NEAR is zero-setup; a NEP-141 token (USDC/USDT) needs a one-time storage_deposit on the recipient.' },
  { name: 'Sui', slug: 'sui', tokens: ['usdc'], family: 'Sui' },
  { name: 'Aptos', slug: 'aptos', tokens: ['usdc', 'usdt'], family: 'Aptos' },
  { name: 'Algorand', slug: 'algorand', tokens: ['usdc'], family: 'Algorand', setup: 'Native ALGO is zero-setup; receiving USDC needs a one-time ASA opt-in on the recipient.' },
  { name: 'Stellar', slug: 'stellar', tokens: ['usdc', 'eurc'], family: 'Stellar', setup: 'Recipient needs a one-time trustline for the asset and an activated, reserve-funded account; native XLM needs no trustline.' },
  { name: 'XRP Ledger', slug: 'xrpl', tokens: ['usdc', 'rlusd'], family: 'XRPL', setup: 'Recipient needs a one-time trustline for the asset and an activated, reserve-funded account; native XRP needs no trustline.' },
  { name: 'Base', slug: 'base', tokens: ['usdc', 'eurc'], family: 'EVM' },
  { name: 'BNB Chain', slug: 'bnb', tokens: ['usdc', 'usdt'], family: 'EVM' },
  { name: 'Arbitrum', slug: 'arbitrum', tokens: ['usdc', 'usdt'], family: 'EVM' },
  { name: 'Polygon', slug: 'polygon', tokens: ['usdc', 'usdt'], family: 'EVM' },
  { name: 'Optimism', slug: 'optimism', tokens: ['usdc', 'usdt'], family: 'EVM' },
  { name: 'Avalanche', slug: 'avalanche', tokens: ['usdc', 'usdt', 'eurc'], family: 'EVM' },
  { name: 'Kaia', slug: 'kaia', tokens: ['usdt'], family: 'EVM', setup: 'Ships Tether-native USD₮ (or native KAIA); there is no Circle-native USDC on Kaia.' },
  { name: 'HyperEVM', slug: 'hyperevm', tokens: ['usdc'], family: 'EVM' },
  { name: 'Monad', slug: 'monad', tokens: ['usdc'], family: 'EVM' },
  { name: 'Mantle', slug: 'mantle', tokens: ['usdc', 'usdt'], family: 'EVM' },
  { name: 'Linea', slug: 'linea', tokens: ['usdc', 'usdt'], family: 'EVM' },
  { name: 'Scroll', slug: 'scroll', tokens: ['usdc', 'usdt'], family: 'EVM' },
  { name: 'zkSync Era', slug: 'zksync', tokens: ['usdc', 'usdt'], family: 'EVM' },
  { name: 'Celo', slug: 'celo', tokens: ['usdc', 'usdt'], family: 'EVM' },
  { name: 'Sonic', slug: 'sonic', tokens: ['usdc', 'usdt'], family: 'EVM' },
  { name: 'Unichain', slug: 'unichain', tokens: ['usdc', 'usdt'], family: 'EVM' },
  { name: 'World Chain', slug: 'worldchain', tokens: ['usdc'], family: 'EVM' },
  { name: 'Sei', slug: 'sei', tokens: ['usdc'], family: 'EVM' },
  { name: 'Injective', slug: 'injective', tokens: ['usdc', 'usdt'], family: 'EVM' },
]

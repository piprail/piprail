import { defineChain, type Chain } from 'viem'
import {
  arbitrum, avalanche, base, bsc, celo, hyperEvm, injective, kaia, linea, mainnet, mantle, monad,
  optimism, polygon, scroll, sei, sonic, unichain, worldchain, zksync,
} from 'viem/chains'

/**
 * ── EVM SECTION: chains ──
 * Chains are a parameter, and the popular ones are built in.
 *
 * The easy path — name a built-in chain:
 *   requirePayment({ chain: 'base', token: 'USDC', amount: '0.05', payTo })   // USDC on Base
 *
 * The exotic path — ANY EVM chain we don't ship, by viem `Chain` or a bare
 * `{ id, rpcUrl }`, plus the token you want paid in:
 *   requirePayment({ chain: someViemChain, token: { address, decimals }, … })
 *   requirePayment({ chain: { id: 1313161554, rpcUrl: 'https://mainnet.aurora.dev' },
 *                    token: { address: '0x…', decimals: 6 }, … })
 *
 * If viem can reach the RPC, PipRail works on it — there is no allowlist.
 */

export interface TokenInfo {
  address: `0x${string}`
  decimals: number
  symbol: string
}

export interface ChainPreset {
  /** The underlying viem chain (id, name, native coin, default RPCs). */
  chain: Chain
  /**
   * Override the default RPC used when the caller passes no `rpcUrl`. Set only
   * where viem's bundled default is unreliable. Public RPCs are rate-limited —
   * production callers should always pass their own `rpcUrl`.
   */
  defaultRpc?: string
  /** Well-known tokens on this chain, keyed by UPPERCASE symbol. */
  tokens: Record<string, TokenInfo>
}

/**
 * Built-in EVM mainnets, each with canonical USDC (decimals included)
 * pre-filled so a developer never pastes a token address. Add a chain = one
 * entry here.
 */
export const CHAINS = {
  ethereum: {
    chain: mainnet,
    // viem's bundled default (eth.merkle.io) is flaky; pin a reliable public RPC.
    defaultRpc: 'https://ethereum-rpc.publicnode.com',
    tokens: {
      USDC: { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6, symbol: 'USDC' },
      USDT: { address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6, symbol: 'USDT' },
    },
  },
  base: {
    chain: base,
    tokens: {
      USDC: { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6, symbol: 'USDC' },
    },
  },
  arbitrum: {
    chain: arbitrum,
    tokens: {
      USDC: { address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6, symbol: 'USDC' },
      USDT: { address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', decimals: 6, symbol: 'USDT' },
    },
  },
  optimism: {
    chain: optimism,
    tokens: {
      USDC: { address: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', decimals: 6, symbol: 'USDC' },
      USDT: { address: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', decimals: 6, symbol: 'USDT' },
    },
  },
  polygon: {
    chain: polygon,
    tokens: {
      USDC: { address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', decimals: 6, symbol: 'USDC' },
      USDT: { address: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', decimals: 6, symbol: 'USDT' },
    },
  },
  bnb: {
    chain: bsc,
    tokens: {
      // Binance-Peg tokens on BNB Chain are 18 decimals (not the usual 6).
      USDC: { address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', decimals: 18, symbol: 'USDC' },
      USDT: { address: '0x55d398326f99059fF775485246999027B3197955', decimals: 18, symbol: 'USDT' },
    },
  },
  avalanche: {
    chain: avalanche,
    tokens: {
      USDC: { address: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', decimals: 6, symbol: 'USDC' },
      USDT: { address: '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7', decimals: 6, symbol: 'USDT' },
    },
  },

  // ── More popular EVM mainnets. Every address below was verified on-chain
  //    (symbol + decimals read via RPC) before being committed here. ──
  mantle: {
    chain: mantle,
    tokens: {
      USDC: { address: '0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9', decimals: 6, symbol: 'USDC' },
      USDT: { address: '0x201EBa5CC46D216Ce6DC03F6a759e8E766e956aE', decimals: 6, symbol: 'USDT' },
    },
  },
  sonic: {
    chain: sonic,
    tokens: {
      USDC: { address: '0x29219dd400f2Bf60E5a23d13Be72B486D4038894', decimals: 6, symbol: 'USDC' },
      USDT: { address: '0x6047828dc181963ba44974801FF68e538dA5eaF9', decimals: 6, symbol: 'USDT' },
    },
  },
  linea: {
    chain: linea,
    tokens: {
      USDC: { address: '0x176211869cA2b568f2A7D4EE941E073a821EE1ff', decimals: 6, symbol: 'USDC' },
      USDT: { address: '0xA219439258ca9da29E9Cc4cE5596924745e12B93', decimals: 6, symbol: 'USDT' },
    },
  },
  scroll: {
    chain: scroll,
    tokens: {
      USDC: { address: '0x06eFdBFf2a14a7c8E15944D1F4A48F9F95F663A4', decimals: 6, symbol: 'USDC' },
      USDT: { address: '0xf55BEC9cafDbE8730f096Aa55dad6D22d44099Df', decimals: 6, symbol: 'USDT' },
    },
  },
  celo: {
    chain: celo,
    tokens: {
      USDC: { address: '0xcebA9300f2b948710d2653dD7B07f33A8B32118C', decimals: 6, symbol: 'USDC' },
      USDT: { address: '0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e', decimals: 6, symbol: 'USDT' },
    },
  },
  zksync: {
    chain: zksync,
    tokens: {
      USDC: { address: '0x1d17CBcF0D6D143135aE902365D2E5e2A16538D4', decimals: 6, symbol: 'USDC' },
      USDT: { address: '0x493257fD37EDB34451f62EDf8D2a0C418852bA4C', decimals: 6, symbol: 'USDT' },
    },
  },
  unichain: {
    chain: unichain,
    tokens: {
      USDC: { address: '0x078D782b760474a361dDA0AF3839290b0EF57AD6', decimals: 6, symbol: 'USDC' },
      USDT: { address: '0x9151434b16b9763660705744891fA906F660EcC5', decimals: 6, symbol: 'USDT' },
    },
  },
  worldchain: {
    chain: worldchain,
    tokens: {
      USDC: { address: '0x79A02482A880bCE3F13e09Da970dC34db4CD24d1', decimals: 6, symbol: 'USDC' },
    },
  },
  // Sei EVM (pacific-1, chainId 1329) — native Circle USDC. Sei's "USDT" is
  // USDT0 (LayerZero/omnichain), not Circle/Tether-native, so it's intentionally
  // omitted; pass it as a custom { address, decimals } if you need it.
  sei: {
    chain: sei,
    tokens: {
      USDC: { address: '0xe15fC38F6D8c56aF07bbCBe3BAf5708A2Bf42392', decimals: 6, symbol: 'USDC' },
    },
  },
  // Injective native EVM (chainId 1776) — native Circle USDC + USDT via the
  // MultiVM Token Standard (one address across EVM + Wasm, not bridged).
  injective: {
    chain: injective,
    tokens: {
      USDC: { address: '0xa00C59fF5a080D2b954d0c75e46E22a0c371235a', decimals: 6, symbol: 'USDC' },
      USDT: { address: '0x88f7F2b685F9692caf8c478f5BADF09eE9B1Cc13', decimals: 6, symbol: 'USDT' },
    },
  },
  // HyperEVM (Hyperliquid, chainId 999) — native Circle USDC, verified on-chain
  // 2026-06-04 (eth_chainId 0x3e7; USDC symbol "USDC", decimals 6). HyperEVM's
  // "USDT" is USDT0 (LayerZero/omnichain), not Circle/Tether-native, so it's
  // intentionally omitted; pass it as a custom { address, decimals } if needed.
  // The highest-activity EVM venue of 2025–26 (perps DEX + on-chain agent vaults).
  hyperevm: {
    chain: hyperEvm,
    tokens: {
      USDC: { address: '0xb88339CB7199b77E23DB6E890353E22632Ba630f', decimals: 6, symbol: 'USDC' },
    },
  },
  // Monad (chainId 143) — native Circle USDC, verified on-chain 2026-06-04
  // (eth_chainId 0x8f; USDC symbol "USDC", decimals 6; CCTP V2). Monad's "USDT"
  // is USDT0 (LayerZero/omnichain), not Circle/Tether-native, so it's
  // intentionally omitted; pass it as a custom { address, decimals } if needed.
  // The biggest new EVM L1 of 2025 (parallel EVM, ~10k TPS).
  monad: {
    chain: monad,
    tokens: {
      USDC: { address: '0x754704Bc059F8C67012fEd69BC8A327a5aafb603', decimals: 6, symbol: 'USDC' },
    },
  },
  // Kaia (ex-Klaytn, chainId 8217) — Tether-native USD₮ verified on-chain 2026-06-08
  // (0xd077…4fDb: symbol "USD₮", name "Tether USD", 6 dp, no bridge markers). Circle issues
  // NO native USDC on Kaia (absent from Circle's list), so USDC is intentionally omitted —
  // pay native KAIA or USD₮ (or pass a custom { address, decimals }). Asia's stablecoin-
  // settlement chain, born from Kakao + LINE.
  kaia: {
    chain: kaia,
    tokens: {
      USDT: { address: '0xd077A400968890Eacc75cdc901F0356c943e4fDb', decimals: 6, symbol: 'USDT' },
    },
  },
} satisfies Record<string, ChainPreset>

/** A built-in EVM chain name. */
export type ChainName = keyof typeof CHAINS

export type ChainInput =
  | ChainName
  | Chain
  | {
      /** EVM chain id, e.g. 5000 for Mantle. */
      id: number
      /** JSON-RPC endpoint. */
      rpcUrl: string
      /** Display name. Defaults to `EVM <id>`. */
      name?: string
      /** Native coin metadata. Defaults to 18-decimal ETH. */
      nativeCurrency?: { name: string; symbol: string; decimals: number }
    }

export interface ResolvedChain {
  chain: Chain
  chainId: number
  rpcUrl: string
  /** Known tokens on this chain (empty for unknown custom chains). */
  tokens: Record<string, TokenInfo>
}

function isViemChain(input: ChainInput): input is Chain {
  return typeof input === 'object' && 'rpcUrls' in input
}

/** Built-in tokens for a chain id — so symbol resolution works even when you
 * pass a raw viem chain or `{ id, rpcUrl }`. */
function knownTokensForId(chainId: number): Record<string, TokenInfo> {
  for (const preset of Object.values(CHAINS)) {
    if (preset.chain.id === chainId) return preset.tokens
  }
  return {}
}

/**
 * Normalise a `ChainInput` (+ optional rpc override) into the
 * `{ chain, chainId, rpcUrl, tokens }` the wallet and verifier need.
 */
export function resolveChain(
  input: ChainInput,
  rpcUrlOverride?: string
): ResolvedChain {
  // Built-in name, e.g. 'base'.
  if (typeof input === 'string') {
    const preset = (CHAINS as Record<string, ChainPreset>)[input]
    if (!preset) {
      const names = Object.keys(CHAINS).join(', ')
      throw new Error(
        `resolveChain: unknown chain "${input}". Built-in names: ${names}. ` +
          `Or pass a viem Chain or { id, rpcUrl } for any other EVM chain.`
      )
    }
    const rpcUrl =
      rpcUrlOverride ?? preset.defaultRpc ?? preset.chain.rpcUrls.default.http[0]
    if (!rpcUrl) {
      throw new Error(`resolveChain: "${input}" has no default RPC URL — pass rpcUrl.`)
    }
    return { chain: preset.chain, chainId: preset.chain.id, rpcUrl, tokens: preset.tokens }
  }

  // A full viem Chain.
  if (isViemChain(input)) {
    const rpcUrl = rpcUrlOverride ?? input.rpcUrls.default.http[0]
    if (!rpcUrl) {
      throw new Error(
        `resolveChain: viem chain ${input.id} has no default RPC URL — pass rpcUrl explicitly.`
      )
    }
    return { chain: input, chainId: input.id, rpcUrl, tokens: knownTokensForId(input.id) }
  }

  // A bare { id, rpcUrl } — any EVM chain.
  const rpcUrl = rpcUrlOverride ?? input.rpcUrl
  if (!rpcUrl) {
    throw new Error(`resolveChain: chain ${input.id} needs an rpcUrl.`)
  }
  const chain = defineChain({
    id: input.id,
    name: input.name ?? `EVM ${input.id}`,
    nativeCurrency:
      input.nativeCurrency ?? { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  })
  return { chain, chainId: input.id, rpcUrl, tokens: knownTokensForId(input.id) }
}

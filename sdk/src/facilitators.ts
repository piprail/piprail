/**
 * Facilitator coverage — the honest, chain-agnostic DATA map of which third-party x402
 * facilitators settle the `exact` scheme on which networks. PURE DATA: imports only the
 * `Caip2` type from `x402.ts` — zero chain libraries (protocol layer, STANDARDS §1).
 *
 * Why it exists: the `exact: true` shorthand (discoverability plan, Phase 7) and an
 * operator picking a facilitator both need to know "is there a known KEYLESS facilitator
 * for my chain?" — WITHOUT a hosted registry (charter: no backend). This map is the SEED;
 * the live truth is `facilitatorCoverage(url)` in `facilitator.ts`, which reads a
 * facilitator's `GET /supported`. The map is grown ONLY from a verified `/supported`
 * read — every entry carries a dated verification comment, never a guess.
 */
import type { Caip2 } from './x402.js'

/** One facilitator known to settle `exact` on a given network. */
export interface KnownFacilitator {
  /** Base URL (no trailing slash), e.g. `https://facilitator.payai.network`. */
  url: string
  /** True when it needs NO API key — buyer AND merchant pay zero gas (the facilitator sponsors it). */
  keyless: boolean
  /** The x402 schemes it settles (today only `exact`). */
  schemes: ReadonlyArray<'exact'>
  /** The exact transfer methods it can settle on this network. */
  settles: ReadonlyArray<'eip3009' | 'permit2' | 'svm' | 'algorand'>
  /** A short human note (who it is / caveat). */
  note?: string
}

/**
 * Seed map: CAIP-2 network → facilitators that settle `exact` there. Deliberately
 * CONSERVATIVE — only endpoint-verified entries. Extend it only after a live
 * `facilitatorCoverage()` read confirms a new (facilitator, network) pair. A merchant on
 * a network not listed here passes an explicit `exact: { settle: { facilitator } }`.
 *
 * NOTE: `x402.org/facilitator` is intentionally ABSENT — it is a Base **Sepolia** testnet
 * facilitator (verified), not a mainnet rail; seeding it would be a false coverage claim.
 */
export const KNOWN_FACILITATORS: Readonly<Record<Caip2, ReadonlyArray<KnownFacilitator>>> = {
  // Base (eip155:8453). Every entry is keyless and LIVE-settled by us (a real EIP-3009
  // exact payment, buyer paid zero ETH) — not just a /supported read — on the dated day.
  'eip155:8453': [
    {
      url: 'https://facilitator.payai.network',
      keyless: true,
      schemes: ['exact'],
      settles: ['eip3009'],
      note: 'PayAI — keyless, sponsors gas (Base USDC EIP-3009). Verified 2026-06-14 (/supported + live demo).',
    },
    {
      url: 'https://facilitator.xpay.sh',
      keyless: true,
      schemes: ['exact'],
      settles: ['eip3009'],
      note: 'xpay — keyless, zero-fee, sponsors gas. LIVE-settled on Base 2026-06-15 (tx 0x2273d5…).',
    },
  ],
  // Monad (eip155:143). Corbits keyless-settles the EVM EIP-3009 exact rail (Monad's native Circle
  // USDC), buyer paid zero gas — a real LIVE settle, not just a /supported read. Makes `exact: true`
  // zero-config gasless on Monad.
  'eip155:143': [
    {
      url: 'https://facilitator.corbits.dev',
      keyless: true,
      schemes: ['exact'],
      settles: ['eip3009'],
      note: 'Corbits (Faremeter) — keyless, sponsors gas (Monad native USDC EIP-3009). LIVE-settled on Monad 2026-06-17 (tx 0x7797be27ce22c17f7433a0389bd22d46e338899b1faac505fffd068174428ae6).',
    },
  ],
  // HyperEVM (eip155:999). Ultravioleta DAO keyless-settles the EVM EIP-3009 exact rail (HyperEVM's
  // native Circle USDC), buyer paid zero gas — a real LIVE settle. UVD is the broadest keyless
  // facilitator (it also lists Celo/Unichain/Optimism/Scroll + many non-EVM); only HyperEVM is
  // seeded here because THE RULE requires a per-chain live settle, and that's the one we proved.
  'eip155:999': [
    {
      url: 'https://facilitator.ultravioletadao.xyz',
      keyless: true,
      schemes: ['exact'],
      settles: ['eip3009'],
      note: 'Ultravioleta DAO — keyless, 100% gas-sponsored (HyperEVM native USDC EIP-3009). LIVE-settled on HyperEVM 2026-06-17 (tx 0x56af8148a92a291f0ce362e250919f7742074e5464ac0f315ad68abaec93bd0a).',
    },
  ],
  // Solana (mainnet-beta). Keyless fee-payer sponsors for the SVM exact rail, each LIVE-settled
  // by us (a real SPL TransferChecked, buyer paid zero SOL) on the dated day — beyond a /supported
  // read. Daydreams + Questflow are intentionally ABSENT: their /supported is public but /verify
  // returns 401 (an API key is required), so they are not keyless for settlement.
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp': [
    {
      url: 'https://facilitator.payai.network',
      keyless: true,
      schemes: ['exact'],
      settles: ['svm'],
      note: 'PayAI — keyless fee-payer sponsor (Solana SPL SVM). LIVE-settled 2026-06-14 (tx 4dL8jRKH…).',
    },
    {
      url: 'https://pay.openfacilitator.io',
      keyless: true,
      schemes: ['exact'],
      settles: ['svm'],
      note: 'OpenFacilitator — keyless (no signup), fee-payer sponsor. LIVE-settled on Solana 2026-06-15 (tx 5BabDtX…).',
    },
    {
      url: 'https://facilitator.corbits.dev',
      keyless: true,
      schemes: ['exact'],
      settles: ['svm'],
      note: 'Corbits — keyless, Solana-first fee-payer sponsor. LIVE-settled on Solana 2026-06-15 (tx BCreYer…).',
    },
  ],
}

/** Known facilitators for a network — an empty array when none is seeded. */
export function knownFacilitatorsFor(network: Caip2): ReadonlyArray<KnownFacilitator> {
  return KNOWN_FACILITATORS[network] ?? []
}

/**
 * The first KEYLESS facilitator that settles `exact` on `network` (optionally for a
 * specific transfer `method`). Returns `undefined` when none is known — the `exact: true`
 * shorthand branches on that to throw a coverage-specific guidance error.
 */
export function firstKeylessFacilitator(
  network: Caip2,
  method?: 'eip3009' | 'permit2' | 'svm' | 'algorand'
): KnownFacilitator | undefined {
  return knownFacilitatorsFor(network).find(
    (f) => f.keyless && f.schemes.includes('exact') && (method === undefined || f.settles.includes(method))
  )
}

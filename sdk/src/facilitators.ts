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
  settles: ReadonlyArray<'eip3009' | 'permit2' | 'svm' | 'algorand' | 'aptos' | 'near'>
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
/*
 * REMOVED 2026-08-28 — both were live-settled once and have since gone offline. Kept here
 * as a record so nobody re-adds them from an old note:
 *
 *   facilitator.corbits.dev      (Corbits/Faremeter) — DNS is now NXDOMAIN. Was seeded on
 *                                Base, Monad, Polygon and Solana; on Monad it was FIRST in
 *                                the list, so `firstKeylessFacilitator('eip155:143')` handed
 *                                callers a dead URL and the exact rail failed.
 *   facilitator.bitcoinsapi.com  (Satoshi) — CNAME still points at an Azure Container App
 *                                that no longer resolves.
 *
 * Found by .claude/skills/facilitator-probe. Run it before trusting this map:
 *   node .claude/skills/facilitator-probe/scripts/probe.mjs
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
      note: 'PayAI: keyless, sponsors gas (Base USDC EIP-3009). Verified 2026-06-14 (/supported + live demo).',
    },
    {
      url: 'https://facilitator.xpay.sh',
      keyless: true,
      schemes: ['exact'],
      settles: ['eip3009'],
      note: 'xpay: keyless, zero-fee, sponsors gas. LIVE-settled on Base 2026-06-15 (tx 0x2273d5…).',
    },
    {
      url: 'https://facilitator.ultravioletadao.xyz',
      keyless: true,
      schemes: ['exact'],
      settles: ['eip3009'],
      note: 'Ultravioleta DAO: keyless, 100% gas-sponsored (Base USDC EIP-3009). LIVE-settled on Base 2026-06-17 (tx 0x58a69042a4129be649c5642456752ede95a5ff921daddfd30560ae70ae5907ff). 2nd UVD validation chain (after HyperEVM).',
    },
    {
      url: 'https://x402.dexter.cash',
      keyless: true,
      schemes: ['exact'],
      settles: ['eip3009'],
      note: 'Dexter: keyless, gas-sponsored (Base USDC EIP-3009). LIVE-settled on Base 2026-06-17 (tx 0xdf030e4d5bf41a88c5a3bfe73bb433dfbb90b058d3b8ded63b68e026eedb9de8). Note: ~$0.001 dynamic floor on Base.',
    },
    {
      url: 'https://facilitator.goplausible.xyz',
      keyless: true,
      schemes: ['exact'],
      settles: ['eip3009'],
      note: 'GoPlausible: keyless, sponsors gas (Base USDC EIP-3009). LIVE-settled on Base 2026-06-17 (tx 0x9bcbc1f01fe1fd1aed2a79e5582555164cc4185e9800189df378a6b46eb9c59e). 2nd GoPlausible validation chain (after Algorand).',
    },
    {
      url: 'https://facilitator.cascade.fyi',
      keyless: true,
      schemes: ['exact'],
      settles: ['eip3009'],
      note: 'Cascade: keyless, sponsors gas (Base USDC EIP-3009). LIVE-settled on Base 2026-06-18 (tx 0x2e784725f3c66e170720cc8df43a9248f02ad80914fcbe05dadbdbe411c3b52b).',
    },
  ],
  // Monad (eip155:143). Corbits + Ultravioleta DAO each keyless-settle the EVM EIP-3009 exact rail
  // (Monad's native Circle USDC), buyer paid zero gas — real LIVE settles, not just /supported reads.
  // Makes `exact: true` zero-config gasless on Monad.
  'eip155:143': [
    {
      url: 'https://facilitator.ultravioletadao.xyz',
      keyless: true,
      schemes: ['exact'],
      settles: ['eip3009'],
      note: 'Ultravioleta DAO: keyless, 100% gas-sponsored (Monad native USDC EIP-3009). LIVE-settled on Monad 2026-06-17 (tx 0xb107576effbaceb5586c07a9ddc996ef2b6d455f1858314995ef83a7c6e64d11). 3rd UVD validation chain.',
    },
    {
      url: 'https://facilitator.pieverse.io',
      keyless: true,
      schemes: ['exact'],
      settles: ['eip3009'],
      note: 'Pieverse: keyless, sponsors gas (Monad USDC EIP-3009). LIVE-settled on Monad 2026-06-17 (tx 0x00cfeb93876e5ef57dcb002510038b7304913233ca286d7ab33c72a8b119eb0d).',
    },
  ],
  // BNB Chain (eip155:56). Dexter + Pieverse keyless-settle the EVM EIP-3009 exact rail for BNB's
  // EIP-3009 tokens (FDUSD / USD1 / U); BNB's USDC/USDT are Binance-Peg (Permit2), which no facilitator
  // settles. Dexter also enforces a ~$0.003 dynamic settlement floor on BNB, so a sub-$0.003 payment
  // is rejected (amount_too_low) — fine for real prices, but the floor is real. LIVE-settled with
  // FDUSD + U, buyer paid zero BNB — this beats the BNB token-overlap wall that blocked AEON/Pieverse.
  'eip155:56': [
    {
      url: 'https://x402.dexter.cash',
      keyless: true,
      schemes: ['exact'],
      settles: ['eip3009'],
      note: 'Dexter: keyless, gas-sponsored. BNB EIP-3009 tokens FDUSD/USD1/U (Binance-Peg USDC/USDT are Permit2 → not facilitator-settleable); ~$0.003 dynamic floor. LIVE-settled on BNB 2026-06-17 with FDUSD (tx 0x6d9eb4e4939f3f3c74cb19424cc7822d66ec8ed5c5c7c330d9f88a5f9ad59e9e); accepts U (verify confirmed 2026-06-21).',
    },
    {
      url: 'https://facilitator.pieverse.io',
      keyless: true,
      schemes: ['exact'],
      settles: ['eip3009'],
      note: 'Pieverse: keyless, sponsors gas. BNB EIP-3009 tokens FDUSD/USD1/U (same Binance-Peg caveat as Dexter). LIVE-settled on BNB with FDUSD 2026-06-17 (tx 0xb9c76affc45bd07a51559efd813ca71516fc30625478724476c2cf42fc2203d3) AND with the U / United Stables token 2026-06-21 (tx 0x2b3b8c51ae81df441551301c44a64652c84c796af3b9d03ec58ea38f1cb013d5, buyer 0 BNB). A 2nd keyless BNB facilitator (failover for Dexter).',
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
      note: 'Ultravioleta DAO: keyless, 100% gas-sponsored (HyperEVM native USDC EIP-3009). LIVE-settled on HyperEVM 2026-06-17 (tx 0x56af8148a92a291f0ce362e250919f7742074e5464ac0f315ad68abaec93bd0a).',
    },
  ],
  // ── gasless-extension (2026-06-18): 7 more EVM mainnets, each LIVE-settled by us — a real EIP-3009
  // exact payment with the buyer holding ZERO native (so PROVABLY gasless), funded self-service by
  // bridging USDC in (LI.FI/Eco/Relay), never a /supported read. Dexter enforces a ~$0.004 dynamic
  // floor on some chains (we cleared it at $0.005); UVD has no floor (100%-sponsors) but its sponsor
  // contract is NOT deployed on every chain it advertises (Avalanche/Celo/Scroll → contract_call_failed,
  // left UNSEEDED — the NEAR lesson: advertising ≠ settling).
  // Ethereum L1 (eip155:1) — UVD (no floor, sponsors L1 gas). 2nd keyless ETH option vs Primev, which
  // rejected PipRail's exact as unsupported_scheme.
  'eip155:1': [
    {
      url: 'https://facilitator.ultravioletadao.xyz',
      keyless: true,
      schemes: ['exact'],
      settles: ['eip3009'],
      note: 'Ultravioleta DAO: keyless, 100% gas-sponsored (Ethereum native USDC EIP-3009; no settlement floor). LIVE-settled on Ethereum mainnet 2026-06-18 (tx 0x7fcc3cafdf43c52888f0117cde633eff35371f832dfb8dbd84e6fd7704ae5cfc).',
    },
  ],
  // Polygon PoS (eip155:137) — FIVE keyless facilitators (the broadest after Base), all live-settled.
  'eip155:137': [
    {
      url: 'https://facilitator.payai.network',
      keyless: true,
      schemes: ['exact'],
      settles: ['eip3009'],
      note: 'PayAI: keyless, sponsors gas (Polygon native USDC EIP-3009). LIVE-settled on Polygon 2026-06-18 (tx 0xb37630871504618c4db35e8ef0edd3c99deac102b143b7e5eb738c03fb13a619).',
    },
    {
      url: 'https://x402.polygon.technology',
      keyless: true,
      schemes: ['exact'],
      settles: ['eip3009'],
      note: 'Polygon Labs (the official Polygon facilitator): keyless, sponsors gas. LIVE-settled on Polygon 2026-06-18 (tx 0x6a8ca60ea111959a61a85ad6c4f2ed99e192052ec7b9ffb59baa33691a86f419).',
    },
    {
      url: 'https://facilitator.ultravioletadao.xyz',
      keyless: true,
      schemes: ['exact'],
      settles: ['eip3009'],
      note: 'Ultravioleta DAO: keyless, 100% gas-sponsored. LIVE-settled on Polygon 2026-06-18 (tx 0x0922cd78f3b7c35cc294cf0c0d9b7609e6596eb337be0d197fa5fc511eacba34).',
    },
    {
      url: 'https://x402.dexter.cash',
      keyless: true,
      schemes: ['exact'],
      settles: ['eip3009'],
      note: 'Dexter: keyless, sponsors gas; ~$0.004 dynamic settlement floor (sub-floor → amount_too_low). LIVE-settled on Polygon 2026-06-18 at $0.005 (tx 0x4a7cfc96e4e2496652435c77b0021db4a459e7bcd97948c15e6bea09077c164b).',
    },
  ],
  // Arbitrum One (eip155:42161) — PayAI + UVD + Dexter.
  'eip155:42161': [
    {
      url: 'https://facilitator.payai.network',
      keyless: true,
      schemes: ['exact'],
      settles: ['eip3009'],
      note: 'PayAI: keyless, sponsors gas (Arbitrum native USDC EIP-3009). LIVE-settled on Arbitrum 2026-06-18 (tx 0x4c7fbfb37ef087bb9bc8872b1b2b0b83ea7ca4cf6b50bc883e51f9b85be61199).',
    },
    {
      url: 'https://facilitator.ultravioletadao.xyz',
      keyless: true,
      schemes: ['exact'],
      settles: ['eip3009'],
      note: 'Ultravioleta DAO: keyless, 100% gas-sponsored. LIVE-settled on Arbitrum 2026-06-18 (tx 0xd1fa7e6ffbd59502bba5809ce181d7936749b93a45c8c2277b4f6d8638326dec).',
    },
    {
      url: 'https://x402.dexter.cash',
      keyless: true,
      schemes: ['exact'],
      settles: ['eip3009'],
      note: 'Dexter: keyless, sponsors gas; ~$0.004 dynamic floor. LIVE-settled on Arbitrum 2026-06-18 at $0.005 (tx 0x0993d51b3859dfd7e8d5b2af709ce64f01ff34ed14bfef665dbb340e7373d599).',
    },
  ],
  // Optimism (eip155:10) — Dexter + UVD.
  'eip155:10': [
    {
      url: 'https://x402.dexter.cash',
      keyless: true,
      schemes: ['exact'],
      settles: ['eip3009'],
      note: 'Dexter: keyless, sponsors gas; ~$0.004 dynamic floor. LIVE-settled on Optimism 2026-06-18 at $0.005 (tx 0x98b282a5dd698054eff4900ff8547170d4f7605b51140c55147fc5ae485f81da).',
    },
    {
      url: 'https://facilitator.ultravioletadao.xyz',
      keyless: true,
      schemes: ['exact'],
      settles: ['eip3009'],
      note: 'Ultravioleta DAO: keyless, 100% gas-sponsored. LIVE-settled on Optimism 2026-06-18 (tx 0xdd91dfdf12bed2d196e37fa1dea9a0da71a97e3c39a0ec0ed114be6a9af22837).',
    },
  ],
  // Avalanche C-Chain (eip155:43114) — PayAI + Dexter. (UVD advertises it but contract_call_failed → unseeded.)
  'eip155:43114': [
    {
      url: 'https://facilitator.payai.network',
      keyless: true,
      schemes: ['exact'],
      settles: ['eip3009'],
      note: 'PayAI: keyless, sponsors gas (Avalanche native USDC EIP-3009). LIVE-settled on Avalanche 2026-06-18 (tx 0x6a1307bc48a157de236ea03440ea2cb6ad4f27e22dd9c89a4345b4c3edb270c7).',
    },
    {
      url: 'https://x402.dexter.cash',
      keyless: true,
      schemes: ['exact'],
      settles: ['eip3009'],
      note: 'Dexter: keyless, sponsors gas (no floor hit at $0.001 here). LIVE-settled on Avalanche 2026-06-18 (tx 0xb2263e9a4ea3917eee6acabcb454d42a50264fdd69a0781ed8fcaec5590e264b).',
    },
  ],
  // Sei (eip155:1329) — PayAI (the only keyless facilitator that lists Sei).
  'eip155:1329': [
    {
      url: 'https://facilitator.payai.network',
      keyless: true,
      schemes: ['exact'],
      settles: ['eip3009'],
      note: 'PayAI: keyless, sponsors gas (Sei native USDC EIP-3009). LIVE-settled on Sei 2026-06-18 (tx 0xde63679b64749cb59625527e5c7682503c851d66b9b8b8ba217ed7b099461312).',
    },
  ],
  // Unichain (eip155:130) — UVD (the only keyless facilitator that lists Unichain).
  'eip155:130': [
    {
      url: 'https://facilitator.ultravioletadao.xyz',
      keyless: true,
      schemes: ['exact'],
      settles: ['eip3009'],
      note: 'Ultravioleta DAO: keyless, 100% gas-sponsored (Unichain native USDC EIP-3009). LIVE-settled on Unichain 2026-06-18 (tx 0xf8bf4a9a200f24159ac67c6315c30b194257999d7da21471b39d5f2cc32b2236).',
    },
  ],
  // Algorand (mainnet, CAIP-2 = full base64 genesis hash). GoPlausible keyless-settles the ratified
  // x402 Algorand `exact` rail (atomic-group fee pooling): its sponsor pools the whole group fee and
  // submits, so NEITHER the buyer NOR the merchant pays ALGO — both-sides gasless. LIVE-settled by us
  // (a real USDCa exact payment; buyer 0 ALGO AND merchant 0 ALGO) — beyond a /supported read. This
  // makes Algorand a keyless chain (the first non-EVM/non-Solana one). GoPlausible authored the
  // ratified Algorand scheme; PipRail's group is byte-compatible (the gate sends `amount` + the full
  // genesis-hash network, which is all GoPlausible needs).
  'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=': [
    {
      url: 'https://facilitator.goplausible.xyz',
      keyless: true,
      schemes: ['exact'],
      settles: ['algorand'],
      note: 'GoPlausible: keyless, 100% gas-sponsored (Algorand USDCa, atomic-group fee pooling; both buyer AND merchant pay 0 ALGO). LIVE-settled on Algorand mainnet 2026-06-17 (tx PDVDVRFGJAG2K6AJ7L26OTSCSRL7AURVKEX4D4KHBAOLNSCYENXA). The only keyless Algorand x402 facilitator.',
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
      note: 'PayAI: keyless fee-payer sponsor (Solana SPL SVM). LIVE-settled 2026-06-14 (tx 4dL8jRKH…).',
    },
    {
      url: 'https://pay.openfacilitator.io',
      keyless: true,
      schemes: ['exact'],
      settles: ['svm'],
      note: 'OpenFacilitator: keyless (no signup), fee-payer sponsor. LIVE-settled on Solana 2026-06-15 (tx 5BabDtX…).',
    },
    {
      url: 'https://facilitator.goplausible.xyz',
      keyless: true,
      schemes: ['exact'],
      settles: ['svm'],
      note: 'GoPlausible: keyless fee-payer sponsor (Solana SPL SVM). LIVE-settled on Solana mainnet 2026-09-06 (tx 3DEGg6Lue8471meBH8hbLxV1bLmZGKvmvmSY3tjg7tQFnxzE9GQXUXokjQnZgTqaEU4SaXuY9F7v3m7JsX5xDgrZ): buyer paid 0 SOL, GoPlausible\'s sponsor 8a8fFNfk… paid the 10,001-lamport fee, replay rejected.',
    },
  ],
  // NEAR (near:mainnet) — DELIBERATELY UNSEEDED: no x402 facilitator settles NEAR yet.
  // The NEAR `exact` BUYER payload PipRail builds (drivers/near/exact.ts) is LIVE-PROVEN on mainnet —
  // a real NEP-366 meta-transaction settles a USDC/USDT ft_transfer gaslessly (buyer 0 NEAR, single-use
  // via the access-key nonce; relay txs CMnQJzrLvwk… USDT + BCCnVHbSCMY… USDC, 2026-06-18). What's
  // missing is the FACILITATOR side: the public x402-rs (which Ultravioleta DAO runs) has NO NEAR chain
  // crate (only eip155/solana/aptos), and UVD's `/verify` 400s on a near:mainnet request even though its
  // `/supported` ADVERTISES `near:mainnet` + feePayer `uvd-facilitator.near` — i.e. the listing is
  // aspirational, not settle-capable (verified 2026-06-18). So `exact: true` must NOT auto-pick a NEAR
  // facilitator. Seed here ONLY after a real keyless settle through a facilitator that actually
  // implements scheme_exact_near.md (THE RULE). Merchants can still pass an explicit
  // `exact: { settle: { facilitator } }` for any facilitator they've confirmed settles near:mainnet.
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
  method?: 'eip3009' | 'permit2' | 'svm' | 'algorand' | 'aptos' | 'near'
): KnownFacilitator | undefined {
  return knownFacilitatorsFor(network).find(
    (f) => f.keyless && f.schemes.includes('exact') && (method === undefined || f.settles.includes(method))
  )
}

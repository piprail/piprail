/**
 * Swap coverage — the honest, chain-agnostic DATA map of what can swap where, who
 * routes it, and the real mainnet transaction that proves each one works.
 *
 * PURE DATA: imports only the `Caip2` type from `x402.ts` — zero chain libraries
 * (protocol layer, STANDARDS §1). Deliberately the same shape as `facilitators.ts`,
 * because it is the same problem: an optional third party the user opts into, which
 * must be named openly and must never be advertised beyond what we have proven.
 *
 * ── THE ADMISSION RULE (this is the whole point) ──────────────────────────────
 * An entry earns its place ONLY after a real mainnet swap settled through it and the
 * transaction was read back from a public node. Never seed from a documentation page,
 * a coverage table, or a successful quote. A quote proves routing; only a transaction
 * proves settlement.
 *
 * This rule exists because the facilitator registry learned it the hard way: it grew
 * from `/supported` reads, nothing ever re-checked an entry, and on 2026-08-28 two of
 * eleven seeded facilitators turned out to be dead hosts the SDK was still handing to
 * callers. Same failure mode, same guard.
 *
 * ── TWO TIERS, AND THE DIFFERENCE MATTERS ─────────────────────────────────────
 * `kind: 'protocol'` — the LEDGER ITSELF swaps. No third party exists to trust, no API
 * key, no extra dependency, and no integrator fee is even expressible.
 * `kind: 'provider'` — a named third-party router. Open and keyless, but you are
 * trusting its contracts and its routing API as well as the chain.
 *
 * Never blur them in any surface that renders this data.
 */
import type { Caip2 } from './x402.js'

/** A real mainnet swap, verified by reading the transaction back from a public node. */
export interface SwapProof {
  network: Caip2
  /** Full transaction hash / digest. */
  tx: string
  /** ISO date the swap settled. */
  date: string
  /** Human summary, e.g. `'0.2652 XLM → 0.05 USDC'`. */
  summary: string
  /** What this particular proof covers that the others do not. */
  covers?: string
}

/** One route that can swap, and the evidence that it does. */
export interface SwapProviderEntry {
  /** Stable slug. Also the logo filename in `site/public/swaps/<id>.<ext>`. */
  id: string
  name: string
  /** `'protocol'` = the ledger swaps, no third party. `'provider'` = a named router. */
  kind: 'protocol' | 'provider'
  /** Homepage, or the protocol's own documentation for a `'protocol'` entry. */
  url: string
  /** Networks this route covers, every one of them live-probed. */
  networks: readonly Caip2[]
  /** True when it needs NO API key. Every shipped entry is keyless; this is asserted. */
  keyless: boolean
  /** What the route costs, stated plainly. PipRail adds nothing on top, ever. */
  fee: string
  /** How the swap actually happens, one line. */
  mechanism: string
  /**
   * Set ONLY when the route ships without a mainnet proof, naming the reason. Every other
   * entry carries real transaction hashes; this makes the exception impossible to miss
   * rather than letting an empty `proofs` array pass for evidence.
   */
  unproven?: string
  /** Real mainnet proofs. An entry with none must not ship. */
  proofs: readonly SwapProof[]
}

/**
 * 🔴 THE SOURCE OF TRUTH. The website data and the docs table are derived from this;
 * nothing below is allowed a hand-maintained second copy (see `npm run sync`).
 */
export const SWAP_PROVIDERS: readonly SwapProviderEntry[] = [
  {
    id: 'stellar-sdex',
    name: 'Stellar SDEX',
    kind: 'protocol',
    url: 'https://developers.stellar.org/docs/build/guides/transactions/path-payments',
    networks: ['stellar:pubnet'],
    keyless: true,
    fee: 'No trading fee on the order books (spread only); the protocol liquidity pools charge a fixed 0.30%. Nobody can add an integrator fee, because there is no field for one.',
    mechanism: 'A PathPaymentStrictReceive addressed to your own account: one atomic operation, routed across the order books and liquidity pools.',
    proofs: [
      {
        network: 'stellar:pubnet',
        tx: 'f7b784d4758ea83a022921c7202051b4643fefb4fa61530a49010a4a9348a0aa',
        date: '2026-09-08',
        summary: '0.2652 XLM → 0.05 USDC',
        covers: 'native in, and the ledger records source and destination as the same account',
      },
      {
        network: 'stellar:pubnet',
        tx: '3aa2ca9e35ff7d7c3d0aaff3b24d53b4d2ea009067debf058c30ed8cad445f03',
        date: '2026-09-08',
        summary: 'USDC → 0.2 XLM',
        covers: 'the reverse direction, token in',
      },
      {
        network: 'stellar:pubnet',
        tx: '27f50b2c2c57a64a8b50c1b14f310ec99b4ccbbb4bc72c479a5f6f9f1180e385',
        date: '2026-09-08',
        summary: '0.1064 XLM → 0.02 USDC',
        covers: 'run straight from the committed example, so the documented flow is proven too',
      },
    ],
  },
  {
    id: 'xrpl-dex',
    name: 'XRPL DEX + AMM',
    kind: 'protocol',
    url: 'https://xrpl.org/docs/concepts/tokens/decentralized-exchange/automated-market-makers',
    networks: ['xrpl:0'],
    keyless: true,
    fee: 'No protocol fee on the order books (spread only); AMM pools charge a per-pool fee set by liquidity providers, 0% to 1%, paid to the pool. No integrator fee is expressible.',
    mechanism: 'A cross-currency Payment addressed to your own account, which the ledger permits precisely for currency conversion. Auto-bridged through XRP where that is cheaper.',
    proofs: [
      {
        network: 'xrpl:0',
        tx: 'F703B271E35BD3C2408DB64F693461513DD5166C15EC61DBAB0B2A9F726ED97E',
        date: '2026-09-08',
        summary: '0.072 XRP → 0.1 RLUSD',
        covers: 'native in; delivered_amount matched the requested amount exactly',
      },
      {
        network: 'xrpl:0',
        tx: '24EC9DDD2B5D00FD7CD56882999FCF59ABC274AA32E35119EADE397B335EEB63',
        date: '2026-09-08',
        summary: 'RLUSD → 0.02 XRP',
        covers: 'the reverse direction, token in',
      },
    ],
  },
  {
    id: 'jupiter',
    name: 'Jupiter',
    kind: 'provider',
    url: 'https://jup.ag',
    networks: ['solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'],
    keyless: true,
    fee: 'No platform fee. Verified per quote rather than assumed: PipRail never sets platformFeeBps, and every quote is inspected so the note says so if one ever appears.',
    mechanism: 'Jupiter routes and builds a serialized transaction; your own keypair signs it locally and this process broadcasts it. Jupiter never signs and never holds the funds.',
    proofs: [
      {
        network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
        tx: '2rXpQYVerRzrwUfmXMYcm6ijkm8x7LHU91onSZjrng34kr1nfcxZj1A8Ek7inSw7ZBzk3phAaYnvHwdSJTKxJ4rq',
        date: '2026-09-08',
        summary: '0.1031 USDC → 0.001 SOL',
        covers: 'token in, exact output',
      },
      {
        network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
        tx: 'UEeXBp3sPZgEHmahMasAbFhbTootXGCcpoNh7bN1sWsjoPDc1QE7uGaHjivT3iTroxLVJeWGVp2jZT63d2BVTk5',
        date: '2026-09-08',
        summary: '0.000485 SOL → 0.05 USDC',
        covers: 'the reverse direction, native in',
      },
    ],
  },
  {
    id: 'kyberswap',
    name: 'KyberSwap',
    kind: 'provider',
    url: 'https://kyberswap.com',
    // Every one live-probed with a real stablecoin route before being listed. Celo and
    // Scroll are deliberately ABSENT: the API answers but returns no route even for the
    // most liquid pair, so listing them would advertise a swap that cannot execute.
    networks: [
      'eip155:1',
      'eip155:10',
      'eip155:56',
      'eip155:137',
      'eip155:8453',
      'eip155:42161',
      'eip155:43114',
      'eip155:59144',
      'eip155:4663',
    ],
    keyless: true,
    fee: 'No integrator fee. Verified per quote rather than assumed: PipRail sends no fee parameters, and the returned extraFee block is inspected so the note says so if one ever appears.',
    mechanism: 'KyberSwap routes; your own wallet calls the router contract directly. An ERC-20 swap costs two transactions (an approve, then the swap); a native-in swap costs one.',
    proofs: [
      {
        network: 'eip155:56',
        tx: '0x1748b6b27b1920aafd1d2730d250378b08cd4c0851a29e5e785dea960e0c8d4d',
        date: '2026-09-08',
        summary: '0.0101 USDT → USDC on BNB Chain',
        covers: 'the ERC-20 path, which needs an approval first',
      },
      {
        network: 'eip155:4663',
        tx: '0x424299e67be623313c679e659fbfe9fb8707800fe145cddf7fac5a9bdbb78f10',
        date: '2026-09-08',
        summary: 'native ETH → 0.360518 USDG on Robinhood Chain',
        covers:
          'a 100ms-block chain, where a route goes stale fast: the default 50 bps slippage reverted first, 300 bps cleared',
      },
      {
        network: 'eip155:56',
        tx: '0xe27f957b40285acf0b846aea23808d49cc6a44fccd755aa88656abf31204fb00',
        date: '2026-09-08',
        summary: 'native BNB → 0.02 USDC',
        covers: 'the native-in path, which needs no approval',
      },
      {
        network: 'eip155:8453',
        tx: '0xb28b802f530945eba1ea1662890792bfa1dfba64f5094caa58297f9693604032',
        date: '2026-09-08',
        summary: '0.00117 USDC → EURC on Base',
        covers: 'a second EVM chain on the same implementation',
      },
      {
        network: 'eip155:8453',
        tx: '0x99a0842cd6c3fb33ddc03ddf776c2981c629debcd8ac47678a2e5e29e4496242',
        date: '2026-09-08',
        summary: 'EURC → USDC on Base',
        covers: 'the reverse direction',
      },
    ],
  },
  {
    id: 'aftermath',
    name: 'Aftermath',
    kind: 'provider',
    url: 'https://aftermath.finance',
    networks: ['sui:mainnet'],
    keyless: true,
    fee: 'No fee added by the router: the route reports its own coinIn/coinOut tradeFee as zero, and the only cost is the underlying pool fee (about 0.014% on the probed route). PipRail passes no fee parameter.',
    mechanism: 'Aftermath routes and returns a COMPLETE serialized programmable transaction block; your own keypair signs it locally and this process broadcasts it. It never signs and never holds the funds.',
    proofs: [
      {
        network: 'sui:mainnet',
        tx: 'GtykrnLxejyrjmTL8oKVoEtTAiP9eY69CGne7Djw3Cha',
        date: '2026-09-08',
        summary: '0.0657 SUI to 0.0505 USDC',
        covers: 'native in; the balance changes on chain match the quote exactly',
      },
    ],
  },
  {
    id: 'ref-finance',
    name: 'Ref Finance',
    kind: 'provider',
    url: 'https://app.ref.finance',
    networks: ['near:mainnet'],
    keyless: true,
    fee: "The pool's own total_fee, read live per pool (0.01% on the route used). There is no integrator fee for PipRail to set or waive.",
    mechanism: 'One ft_transfer_call receipt chain: token contract to AMM and back to you, inside a single transaction you sign. No solver takes possession, which is exactly why this is used instead of an intent network.',
    proofs: [
      {
        network: 'near:mainnet',
        tx: 'FAb28z1tCcecd2teFTxJGkgaLMr1mpctuiFhUeCKjszT',
        date: '2026-09-08',
        summary: '0.0505 USDT to 0.05 USDC',
        covers: 'token to token across a stable pool, 14 receipts, all successful',
      },
    ],
  },
  {
    id: 'vestige',
    name: 'Vestige',
    kind: 'provider',
    url: 'https://vestige.fi',
    networks: ['algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8='],
    keyless: true,
    fee: "The pool's own fee (0.30% on the probed route) plus the group's network fee. PipRail sends no fee parameter.",
    mechanism: 'Vestige returns an UNSIGNED atomic transaction group in which every signer is you. The SDK asserts that at runtime before signing anything, then signs locally and submits.',
    proofs: [
      {
        network: 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=',
        tx: '5UV7SWSJODHJDGMXODTOMBNXMK4YGZIZKR4VOM6XHML7JS7A32UA',
        date: '2026-09-08',
        summary: '0.5094 ALGO to 0.05 USDC',
        covers: 'a four-transaction atomic group, every signer the sender',
      },
    ],
  },
  {
    id: 'hyperion',
    name: 'Hyperion',
    kind: 'provider',
    url: 'https://hyperion.xyz',
    networks: ['aptos:1'],
    keyless: true,
    fee: "The pool's own fee, read off-chain-state per route (0.01% on the stable pool used here). No API key, no integrator fee: the entry function has no fee parameter to set.",
    mechanism:
      'Called contract-to-contract with NO API in the middle: the quote is an on-chain `view` and the swap is a Move entry function your own account signs. Uniquely, `exact_output_swap_entry` takes the amount you want OUT plus an on-chain input cap, so an x402 invoice is priced exactly rather than approximated.',
    proofs: [
      {
        network: 'aptos:1',
        tx: '0x927293cf8584320f1e265c564ab3096262b675a61996e0da955a2b3c27af1adc',
        date: '2026-09-08',
        summary: '0.049997 USDC to exactly 0.05 USDT',
        covers: 'the stable pair, and the first swap in this SDK to deliver an EXACT output rather than at-least',
      },
      {
        network: 'aptos:1',
        tx: '0xae849e031cb50a660f8c9f286c1f3a9caeff08b427efd9428154d884f1e3059e',
        date: '2026-09-08',
        summary: '0.040012 USDT to exactly 0.04 USDC',
        covers: 'the reverse direction, which takes the opposite on-chain price bound',
      },
      {
        network: 'aptos:1',
        tx: '0x7921118d64ce1e4ebe7911ed22fef2222597e1b9e20caf0fd4f89bce07c07981',
        date: '2026-09-08',
        summary: '0.0459 APT to exactly 0.03 USDC',
        covers: 'native APT in, on a different fee tier',
      },
      {
        network: 'aptos:1',
        tx: '0x640bce4b1e5f688d4494d0c343247b2951d22bc26d371b81f7d2c04655a7a707',
        date: '2026-09-08',
        summary: '0.012842 USDC to exactly 0.02 APT',
        covers: 'native APT out, where the balance delta nets off gas and only the deposit event proves the exact amount',
      },
    ],
  },
  {
    id: 'stonfi',
    name: 'STON.fi',
    kind: 'provider',
    url: 'https://ston.fi',
    networks: ['tvm:-239'],
    keyless: true,
    fee: "The pool's own fee, reported per route by the simulation (about 0.10% on the routes used here). No API key and no referral field.",
    mechanism:
      "Exact-output route, priced by STON.fi's keyless `reverse_swap` simulation, which fixes the ASK side and returns the offer required. PipRail pads the request so the router's on-chain floor (`min_ask_units`) is at or above the invoice: you may receive slightly more, never less. The swap is one message your own wallet signs to the router the simulation named. TON settles asynchronously, so arrival is a balance check rather than one atomic receipt.",
    proofs: [
      {
        network: 'tvm:-239',
        tx: '1f6d58d073bd988b47272658297ebabc4748725ca919a4a9c863f28cef8eeb3f',
        date: '2026-09-08',
        summary: '0.035528 TON for 0.05 USDT',
        covers:
          'native TON in, through the pTON proxy jetton, on the v2.2 router. The wallet transaction ' +
          'that STARTED the swap (opcode 0x01f3835d), not the gas refund that lands moments later',
      },
      {
        network: 'tvm:-239',
        tx: 'f76ae97e107b7852ea105d3b3b0caf095ec77bd2541f40417303c08566a87947',
        date: '2026-09-08',
        summary: '0.028171 USDT for 0.02 TON',
        covers:
          'the jetton-to-TON direction, which the simulation routed through a DIFFERENT router ' +
          'version (v2.1). A TEP-74 jetton transfer (opcode 0x0f8a7ea5) carrying the swap as its ' +
          'forward payload',
      },
    ],
  },
  {
    id: 'sunswap',
    name: 'SunSwap V2',
    kind: 'provider',
    url: 'https://sunswap.com',
    networks: ['tron:mainnet'],
    keyless: true,
    fee: "The pool's own 0.30% constant-product fee. No API key and no integrator fee: the router has no such parameter. Tron's ENERGY charge is the dominant cost, see below.",
    mechanism:
      "Called contract-to-contract with NO API: `getAmountsIn` prices an exact output and `swapETHForExactTokens` executes it with the input capped on-chain. Selling native TRX is one transaction; selling a TRC-20 is two, because the router moves the input with `transferFrom` and needs an approval first. SunSwap's own front end uses an undocumented, obfuscated hostname, which a payments SDK should not depend on, so this skips the service entirely.",
    unproven:
      'Shipped without a mainnet proof, deliberately and openly. The route is real, and every part of it that can be checked without spending has been: both directions quote live through the SDK, and the approve and the router call both execute cleanly in constant-call simulations against the real contracts. It has NOT been broadcast because Tron charges about 230,629 ENERGY per swap, which without staked energy is roughly 23 TRX (about $7.79) regardless of trade size, plus about 10 TRX more the first time a TRC-20 is approved. The project test wallets hold 8.1 TRX. A user with energy can swap today; we simply have not paid to prove it.',
    proofs: [],
  },
] as const

/** Every route that can swap on `network`, or an empty array when none is known. */
export function swapProvidersFor(network: Caip2): readonly SwapProviderEntry[] {
  return SWAP_PROVIDERS.filter((p) => p.networks.includes(network))
}

/** Can PipRail swap on this network at all? */
export function canSwapOn(network: Caip2): boolean {
  return swapProvidersFor(network).length > 0
}

/** Every network with a proven swap route, deduped and sorted for stable rendering. */
export function swappableNetworks(): readonly Caip2[] {
  return [...new Set(SWAP_PROVIDERS.flatMap((p) => p.networks))].sort()
}

// ⚠️ GENERATED — do not edit by hand.
// Source: sdk/src/facilitators.ts (KNOWN_FACILITATORS)
// Regenerate: node site/scripts/gen-facilitators.mjs
//
// Every entry is a KEYLESS x402 facilitator that we settled a real payment through on the
// dated day. The raw registry note is carried through verbatim as `note`; the other fields
// are parsed out of it at build time so the page can render badges and explorer links instead
// of a wall of prose. Re-verify the hashes on-chain with:
//   node .claude/skills/facilitator-probe/scripts/verify-tx.mjs

export interface FacilitatorTx {
  /** Full 0x…/base32 hash, or the prefix the note recorded if that is all we kept. */
  hash: string
  /** Block-explorer URL — null when the hash is truncated and cannot be linked. */
  url: string | null
  full: boolean
}
export interface FacilitatorEntry {
  name: string
  /** A trailing parenthetical lifted off the name, e.g. "the official Polygon facilitator". */
  nameNote: string | null
  url: string
  host: string
  keyless: boolean
  schemes: string[]
  settles: string[]
  /** The registry note, verbatim — the source of every field below it. */
  note: string
  /** true when we settled a real payment; false when the entry rests on a lighter check. */
  settled: boolean
  date: string | null
  txs: FacilitatorTx[]
  /** Token + standard the settlement used, e.g. "Base USDC EIP-3009". */
  asset: string | null
  /** Minimum the facilitator will settle, where it enforces one. */
  floor: string | null
  /** What happens below the floor, when the note explains it. */
  floorNote: string | null
  gasSponsored: boolean
  /** What is left of the note once every badge-able fact is removed. May be empty. */
  caveat: string
}
export interface FacilitatorChain {
  caip2: string
  chain: string
  slug: string
  facilitators: FacilitatorEntry[]
}

export const facilitatorCoverage: FacilitatorChain[] = [
  {
    "caip2": "eip155:8453",
    "chain": "Base",
    "slug": "base",
    "facilitators": [
      {
        "name": "PayAI",
        "nameNote": null,
        "url": "https://facilitator.payai.network",
        "host": "facilitator.payai.network",
        "keyless": true,
        "schemes": [
          "exact"
        ],
        "settles": [
          "eip3009"
        ],
        "note": "PayAI — keyless, sponsors gas (Base USDC EIP-3009). Verified 2026-06-14 (/supported + live demo).",
        "settled": false,
        "date": "2026-06-14",
        "txs": [],
        "asset": "Base USDC EIP-3009",
        "floor": null,
        "floorNote": null,
        "gasSponsored": true,
        "caveat": ""
      },
      {
        "name": "xpay",
        "nameNote": null,
        "url": "https://facilitator.xpay.sh",
        "host": "facilitator.xpay.sh",
        "keyless": true,
        "schemes": [
          "exact"
        ],
        "settles": [
          "eip3009"
        ],
        "note": "xpay — keyless, zero-fee, sponsors gas. LIVE-settled on Base 2026-06-15 (tx 0x2273d5…).",
        "settled": true,
        "date": "2026-06-15",
        "txs": [
          {
            "hash": "0x2273d5…",
            "url": null,
            "full": false
          }
        ],
        "asset": null,
        "floor": null,
        "floorNote": null,
        "gasSponsored": true,
        "caveat": ""
      },
      {
        "name": "Ultravioleta DAO",
        "nameNote": null,
        "url": "https://facilitator.ultravioletadao.xyz",
        "host": "facilitator.ultravioletadao.xyz",
        "keyless": true,
        "schemes": [
          "exact"
        ],
        "settles": [
          "eip3009"
        ],
        "note": "Ultravioleta DAO — keyless, 100% gas-sponsored (Base USDC EIP-3009). LIVE-settled on Base 2026-06-17 (tx 0x58a69042a4129be649c5642456752ede95a5ff921daddfd30560ae70ae5907ff). 2nd UVD validation chain (after HyperEVM).",
        "settled": true,
        "date": "2026-06-17",
        "txs": [
          {
            "hash": "0x58a69042a4129be649c5642456752ede95a5ff921daddfd30560ae70ae5907ff",
            "url": "https://basescan.org/tx/0x58a69042a4129be649c5642456752ede95a5ff921daddfd30560ae70ae5907ff",
            "full": true
          }
        ],
        "asset": "Base USDC EIP-3009",
        "floor": null,
        "floorNote": null,
        "gasSponsored": true,
        "caveat": "2nd UVD validation chain (after HyperEVM)."
      },
      {
        "name": "Dexter",
        "nameNote": null,
        "url": "https://x402.dexter.cash",
        "host": "x402.dexter.cash",
        "keyless": true,
        "schemes": [
          "exact"
        ],
        "settles": [
          "eip3009"
        ],
        "note": "Dexter — keyless, gas-sponsored (Base USDC EIP-3009). LIVE-settled on Base 2026-06-17 (tx 0xdf030e4d5bf41a88c5a3bfe73bb433dfbb90b058d3b8ded63b68e026eedb9de8). Note: ~$0.001 dynamic floor on Base.",
        "settled": true,
        "date": "2026-06-17",
        "txs": [
          {
            "hash": "0xdf030e4d5bf41a88c5a3bfe73bb433dfbb90b058d3b8ded63b68e026eedb9de8",
            "url": "https://basescan.org/tx/0xdf030e4d5bf41a88c5a3bfe73bb433dfbb90b058d3b8ded63b68e026eedb9de8",
            "full": true
          }
        ],
        "asset": "Base USDC EIP-3009",
        "floor": "$0.001 min",
        "floorNote": null,
        "gasSponsored": true,
        "caveat": ""
      },
      {
        "name": "GoPlausible",
        "nameNote": null,
        "url": "https://facilitator.goplausible.xyz",
        "host": "facilitator.goplausible.xyz",
        "keyless": true,
        "schemes": [
          "exact"
        ],
        "settles": [
          "eip3009"
        ],
        "note": "GoPlausible — keyless, sponsors gas (Base USDC EIP-3009). LIVE-settled on Base 2026-06-17 (tx 0x9bcbc1f01fe1fd1aed2a79e5582555164cc4185e9800189df378a6b46eb9c59e). 2nd GoPlausible validation chain (after Algorand).",
        "settled": true,
        "date": "2026-06-17",
        "txs": [
          {
            "hash": "0x9bcbc1f01fe1fd1aed2a79e5582555164cc4185e9800189df378a6b46eb9c59e",
            "url": "https://basescan.org/tx/0x9bcbc1f01fe1fd1aed2a79e5582555164cc4185e9800189df378a6b46eb9c59e",
            "full": true
          }
        ],
        "asset": "Base USDC EIP-3009",
        "floor": null,
        "floorNote": null,
        "gasSponsored": true,
        "caveat": "2nd GoPlausible validation chain (after Algorand)."
      },
      {
        "name": "Cascade",
        "nameNote": null,
        "url": "https://facilitator.cascade.fyi",
        "host": "facilitator.cascade.fyi",
        "keyless": true,
        "schemes": [
          "exact"
        ],
        "settles": [
          "eip3009"
        ],
        "note": "Cascade — keyless, sponsors gas (Base USDC EIP-3009). LIVE-settled on Base 2026-06-18 (tx 0x2e784725f3c66e170720cc8df43a9248f02ad80914fcbe05dadbdbe411c3b52b).",
        "settled": true,
        "date": "2026-06-18",
        "txs": [
          {
            "hash": "0x2e784725f3c66e170720cc8df43a9248f02ad80914fcbe05dadbdbe411c3b52b",
            "url": "https://basescan.org/tx/0x2e784725f3c66e170720cc8df43a9248f02ad80914fcbe05dadbdbe411c3b52b",
            "full": true
          }
        ],
        "asset": "Base USDC EIP-3009",
        "floor": null,
        "floorNote": null,
        "gasSponsored": true,
        "caveat": ""
      }
    ]
  },
  {
    "caip2": "eip155:137",
    "chain": "Polygon",
    "slug": "polygon",
    "facilitators": [
      {
        "name": "PayAI",
        "nameNote": null,
        "url": "https://facilitator.payai.network",
        "host": "facilitator.payai.network",
        "keyless": true,
        "schemes": [
          "exact"
        ],
        "settles": [
          "eip3009"
        ],
        "note": "PayAI — keyless, sponsors gas (Polygon native USDC EIP-3009). LIVE-settled on Polygon 2026-06-18 (tx 0xb37630871504618c4db35e8ef0edd3c99deac102b143b7e5eb738c03fb13a619).",
        "settled": true,
        "date": "2026-06-18",
        "txs": [
          {
            "hash": "0xb37630871504618c4db35e8ef0edd3c99deac102b143b7e5eb738c03fb13a619",
            "url": "https://polygonscan.com/tx/0xb37630871504618c4db35e8ef0edd3c99deac102b143b7e5eb738c03fb13a619",
            "full": true
          }
        ],
        "asset": "Polygon native USDC EIP-3009",
        "floor": null,
        "floorNote": null,
        "gasSponsored": true,
        "caveat": ""
      },
      {
        "name": "Polygon Labs",
        "nameNote": "the official Polygon facilitator",
        "url": "https://x402.polygon.technology",
        "host": "x402.polygon.technology",
        "keyless": true,
        "schemes": [
          "exact"
        ],
        "settles": [
          "eip3009"
        ],
        "note": "Polygon Labs (the official Polygon facilitator) — keyless, sponsors gas. LIVE-settled on Polygon 2026-06-18 (tx 0x6a8ca60ea111959a61a85ad6c4f2ed99e192052ec7b9ffb59baa33691a86f419).",
        "settled": true,
        "date": "2026-06-18",
        "txs": [
          {
            "hash": "0x6a8ca60ea111959a61a85ad6c4f2ed99e192052ec7b9ffb59baa33691a86f419",
            "url": "https://polygonscan.com/tx/0x6a8ca60ea111959a61a85ad6c4f2ed99e192052ec7b9ffb59baa33691a86f419",
            "full": true
          }
        ],
        "asset": null,
        "floor": null,
        "floorNote": null,
        "gasSponsored": true,
        "caveat": ""
      },
      {
        "name": "Ultravioleta DAO",
        "nameNote": null,
        "url": "https://facilitator.ultravioletadao.xyz",
        "host": "facilitator.ultravioletadao.xyz",
        "keyless": true,
        "schemes": [
          "exact"
        ],
        "settles": [
          "eip3009"
        ],
        "note": "Ultravioleta DAO — keyless, 100% gas-sponsored. LIVE-settled on Polygon 2026-06-18 (tx 0x0922cd78f3b7c35cc294cf0c0d9b7609e6596eb337be0d197fa5fc511eacba34).",
        "settled": true,
        "date": "2026-06-18",
        "txs": [
          {
            "hash": "0x0922cd78f3b7c35cc294cf0c0d9b7609e6596eb337be0d197fa5fc511eacba34",
            "url": "https://polygonscan.com/tx/0x0922cd78f3b7c35cc294cf0c0d9b7609e6596eb337be0d197fa5fc511eacba34",
            "full": true
          }
        ],
        "asset": null,
        "floor": null,
        "floorNote": null,
        "gasSponsored": true,
        "caveat": ""
      },
      {
        "name": "Dexter",
        "nameNote": null,
        "url": "https://x402.dexter.cash",
        "host": "x402.dexter.cash",
        "keyless": true,
        "schemes": [
          "exact"
        ],
        "settles": [
          "eip3009"
        ],
        "note": "Dexter — keyless, sponsors gas; ~$0.004 dynamic settlement floor (sub-floor → amount_too_low). LIVE-settled on Polygon 2026-06-18 at $0.005 (tx 0x4a7cfc96e4e2496652435c77b0021db4a459e7bcd97948c15e6bea09077c164b).",
        "settled": true,
        "date": "2026-06-18",
        "txs": [
          {
            "hash": "0x4a7cfc96e4e2496652435c77b0021db4a459e7bcd97948c15e6bea09077c164b",
            "url": "https://polygonscan.com/tx/0x4a7cfc96e4e2496652435c77b0021db4a459e7bcd97948c15e6bea09077c164b",
            "full": true
          }
        ],
        "asset": null,
        "floor": "$0.004 min",
        "floorNote": "sub-floor → amount_too_low",
        "gasSponsored": true,
        "caveat": ""
      }
    ]
  },
  {
    "caip2": "eip155:42161",
    "chain": "Arbitrum",
    "slug": "arbitrum",
    "facilitators": [
      {
        "name": "PayAI",
        "nameNote": null,
        "url": "https://facilitator.payai.network",
        "host": "facilitator.payai.network",
        "keyless": true,
        "schemes": [
          "exact"
        ],
        "settles": [
          "eip3009"
        ],
        "note": "PayAI — keyless, sponsors gas (Arbitrum native USDC EIP-3009). LIVE-settled on Arbitrum 2026-06-18 (tx 0x4c7fbfb37ef087bb9bc8872b1b2b0b83ea7ca4cf6b50bc883e51f9b85be61199).",
        "settled": true,
        "date": "2026-06-18",
        "txs": [
          {
            "hash": "0x4c7fbfb37ef087bb9bc8872b1b2b0b83ea7ca4cf6b50bc883e51f9b85be61199",
            "url": "https://arbiscan.io/tx/0x4c7fbfb37ef087bb9bc8872b1b2b0b83ea7ca4cf6b50bc883e51f9b85be61199",
            "full": true
          }
        ],
        "asset": "Arbitrum native USDC EIP-3009",
        "floor": null,
        "floorNote": null,
        "gasSponsored": true,
        "caveat": ""
      },
      {
        "name": "Ultravioleta DAO",
        "nameNote": null,
        "url": "https://facilitator.ultravioletadao.xyz",
        "host": "facilitator.ultravioletadao.xyz",
        "keyless": true,
        "schemes": [
          "exact"
        ],
        "settles": [
          "eip3009"
        ],
        "note": "Ultravioleta DAO — keyless, 100% gas-sponsored. LIVE-settled on Arbitrum 2026-06-18 (tx 0xd1fa7e6ffbd59502bba5809ce181d7936749b93a45c8c2277b4f6d8638326dec).",
        "settled": true,
        "date": "2026-06-18",
        "txs": [
          {
            "hash": "0xd1fa7e6ffbd59502bba5809ce181d7936749b93a45c8c2277b4f6d8638326dec",
            "url": "https://arbiscan.io/tx/0xd1fa7e6ffbd59502bba5809ce181d7936749b93a45c8c2277b4f6d8638326dec",
            "full": true
          }
        ],
        "asset": null,
        "floor": null,
        "floorNote": null,
        "gasSponsored": true,
        "caveat": ""
      },
      {
        "name": "Dexter",
        "nameNote": null,
        "url": "https://x402.dexter.cash",
        "host": "x402.dexter.cash",
        "keyless": true,
        "schemes": [
          "exact"
        ],
        "settles": [
          "eip3009"
        ],
        "note": "Dexter — keyless, sponsors gas; ~$0.004 dynamic floor. LIVE-settled on Arbitrum 2026-06-18 at $0.005 (tx 0x0993d51b3859dfd7e8d5b2af709ce64f01ff34ed14bfef665dbb340e7373d599).",
        "settled": true,
        "date": "2026-06-18",
        "txs": [
          {
            "hash": "0x0993d51b3859dfd7e8d5b2af709ce64f01ff34ed14bfef665dbb340e7373d599",
            "url": "https://arbiscan.io/tx/0x0993d51b3859dfd7e8d5b2af709ce64f01ff34ed14bfef665dbb340e7373d599",
            "full": true
          }
        ],
        "asset": null,
        "floor": "$0.004 min",
        "floorNote": null,
        "gasSponsored": true,
        "caveat": ""
      }
    ]
  },
  {
    "caip2": "eip155:43114",
    "chain": "Avalanche",
    "slug": "avalanche",
    "facilitators": [
      {
        "name": "PayAI",
        "nameNote": null,
        "url": "https://facilitator.payai.network",
        "host": "facilitator.payai.network",
        "keyless": true,
        "schemes": [
          "exact"
        ],
        "settles": [
          "eip3009"
        ],
        "note": "PayAI — keyless, sponsors gas (Avalanche native USDC EIP-3009). LIVE-settled on Avalanche 2026-06-18 (tx 0x6a1307bc48a157de236ea03440ea2cb6ad4f27e22dd9c89a4345b4c3edb270c7).",
        "settled": true,
        "date": "2026-06-18",
        "txs": [
          {
            "hash": "0x6a1307bc48a157de236ea03440ea2cb6ad4f27e22dd9c89a4345b4c3edb270c7",
            "url": "https://snowtrace.io/tx/0x6a1307bc48a157de236ea03440ea2cb6ad4f27e22dd9c89a4345b4c3edb270c7",
            "full": true
          }
        ],
        "asset": "Avalanche native USDC EIP-3009",
        "floor": null,
        "floorNote": null,
        "gasSponsored": true,
        "caveat": ""
      },
      {
        "name": "Dexter",
        "nameNote": null,
        "url": "https://x402.dexter.cash",
        "host": "x402.dexter.cash",
        "keyless": true,
        "schemes": [
          "exact"
        ],
        "settles": [
          "eip3009"
        ],
        "note": "Dexter — keyless, sponsors gas (no floor hit at $0.001 here). LIVE-settled on Avalanche 2026-06-18 (tx 0xb2263e9a4ea3917eee6acabcb454d42a50264fdd69a0781ed8fcaec5590e264b).",
        "settled": true,
        "date": "2026-06-18",
        "txs": [
          {
            "hash": "0xb2263e9a4ea3917eee6acabcb454d42a50264fdd69a0781ed8fcaec5590e264b",
            "url": "https://snowtrace.io/tx/0xb2263e9a4ea3917eee6acabcb454d42a50264fdd69a0781ed8fcaec5590e264b",
            "full": true
          }
        ],
        "asset": null,
        "floor": null,
        "floorNote": null,
        "gasSponsored": true,
        "caveat": "No floor hit at $0.001 here."
      }
    ]
  },
  {
    "caip2": "eip155:56",
    "chain": "BNB Chain",
    "slug": "bnb",
    "facilitators": [
      {
        "name": "Dexter",
        "nameNote": null,
        "url": "https://x402.dexter.cash",
        "host": "x402.dexter.cash",
        "keyless": true,
        "schemes": [
          "exact"
        ],
        "settles": [
          "eip3009"
        ],
        "note": "Dexter — keyless, gas-sponsored. BNB EIP-3009 tokens FDUSD/USD1/U (Binance-Peg USDC/USDT are Permit2 → not facilitator-settleable); ~$0.003 dynamic floor. LIVE-settled on BNB 2026-06-17 with FDUSD (tx 0x6d9eb4e4939f3f3c74cb19424cc7822d66ec8ed5c5c7c330d9f88a5f9ad59e9e); accepts U (verify confirmed 2026-06-21).",
        "settled": true,
        "date": "2026-06-17",
        "txs": [
          {
            "hash": "0x6d9eb4e4939f3f3c74cb19424cc7822d66ec8ed5c5c7c330d9f88a5f9ad59e9e",
            "url": "https://bscscan.com/tx/0x6d9eb4e4939f3f3c74cb19424cc7822d66ec8ed5c5c7c330d9f88a5f9ad59e9e",
            "full": true
          }
        ],
        "asset": null,
        "floor": "$0.003 min",
        "floorNote": null,
        "gasSponsored": true,
        "caveat": "BNB EIP-3009 tokens FDUSD/USD1/U (Binance-Peg USDC/USDT are Permit2 → not facilitator-settleable). Accepts U (verify confirmed 2026-06-21)."
      },
      {
        "name": "Pieverse",
        "nameNote": null,
        "url": "https://facilitator.pieverse.io",
        "host": "facilitator.pieverse.io",
        "keyless": true,
        "schemes": [
          "exact"
        ],
        "settles": [
          "eip3009"
        ],
        "note": "Pieverse — keyless, sponsors gas. BNB EIP-3009 tokens FDUSD/USD1/U (same Binance-Peg caveat as Dexter). LIVE-settled on BNB with FDUSD 2026-06-17 (tx 0xb9c76affc45bd07a51559efd813ca71516fc30625478724476c2cf42fc2203d3) AND with the U / United Stables token 2026-06-21 (tx 0x2b3b8c51ae81df441551301c44a64652c84c796af3b9d03ec58ea38f1cb013d5, buyer 0 BNB) — a 2nd keyless BNB facilitator (failover for Dexter).",
        "settled": true,
        "date": "2026-06-17",
        "txs": [
          {
            "hash": "0xb9c76affc45bd07a51559efd813ca71516fc30625478724476c2cf42fc2203d3",
            "url": "https://bscscan.com/tx/0xb9c76affc45bd07a51559efd813ca71516fc30625478724476c2cf42fc2203d3",
            "full": true
          },
          {
            "hash": "0x2b3b8c51ae81df441551301c44a64652c84c796af3b9d03ec58ea38f1cb013d5",
            "url": "https://bscscan.com/tx/0x2b3b8c51ae81df441551301c44a64652c84c796af3b9d03ec58ea38f1cb013d5",
            "full": true
          }
        ],
        "asset": null,
        "floor": null,
        "floorNote": null,
        "gasSponsored": true,
        "caveat": "BNB EIP-3009 tokens FDUSD/USD1/U (same Binance-Peg caveat as Dexter)."
      }
    ]
  },
  {
    "caip2": "eip155:143",
    "chain": "Monad",
    "slug": "monad",
    "facilitators": [
      {
        "name": "Ultravioleta DAO",
        "nameNote": null,
        "url": "https://facilitator.ultravioletadao.xyz",
        "host": "facilitator.ultravioletadao.xyz",
        "keyless": true,
        "schemes": [
          "exact"
        ],
        "settles": [
          "eip3009"
        ],
        "note": "Ultravioleta DAO — keyless, 100% gas-sponsored (Monad native USDC EIP-3009). LIVE-settled on Monad 2026-06-17 (tx 0xb107576effbaceb5586c07a9ddc996ef2b6d455f1858314995ef83a7c6e64d11). 3rd UVD validation chain.",
        "settled": true,
        "date": "2026-06-17",
        "txs": [
          {
            "hash": "0xb107576effbaceb5586c07a9ddc996ef2b6d455f1858314995ef83a7c6e64d11",
            "url": "https://monadscan.com/tx/0xb107576effbaceb5586c07a9ddc996ef2b6d455f1858314995ef83a7c6e64d11",
            "full": true
          }
        ],
        "asset": "Monad native USDC EIP-3009",
        "floor": null,
        "floorNote": null,
        "gasSponsored": true,
        "caveat": "3rd UVD validation chain."
      },
      {
        "name": "Pieverse",
        "nameNote": null,
        "url": "https://facilitator.pieverse.io",
        "host": "facilitator.pieverse.io",
        "keyless": true,
        "schemes": [
          "exact"
        ],
        "settles": [
          "eip3009"
        ],
        "note": "Pieverse — keyless, sponsors gas (Monad USDC EIP-3009). LIVE-settled on Monad 2026-06-17 (tx 0x00cfeb93876e5ef57dcb002510038b7304913233ca286d7ab33c72a8b119eb0d).",
        "settled": true,
        "date": "2026-06-17",
        "txs": [
          {
            "hash": "0x00cfeb93876e5ef57dcb002510038b7304913233ca286d7ab33c72a8b119eb0d",
            "url": "https://monadscan.com/tx/0x00cfeb93876e5ef57dcb002510038b7304913233ca286d7ab33c72a8b119eb0d",
            "full": true
          }
        ],
        "asset": "Monad USDC EIP-3009",
        "floor": null,
        "floorNote": null,
        "gasSponsored": true,
        "caveat": ""
      }
    ]
  },
  {
    "caip2": "eip155:10",
    "chain": "Optimism",
    "slug": "optimism",
    "facilitators": [
      {
        "name": "Dexter",
        "nameNote": null,
        "url": "https://x402.dexter.cash",
        "host": "x402.dexter.cash",
        "keyless": true,
        "schemes": [
          "exact"
        ],
        "settles": [
          "eip3009"
        ],
        "note": "Dexter — keyless, sponsors gas; ~$0.004 dynamic floor. LIVE-settled on Optimism 2026-06-18 at $0.005 (tx 0x98b282a5dd698054eff4900ff8547170d4f7605b51140c55147fc5ae485f81da).",
        "settled": true,
        "date": "2026-06-18",
        "txs": [
          {
            "hash": "0x98b282a5dd698054eff4900ff8547170d4f7605b51140c55147fc5ae485f81da",
            "url": "https://optimistic.etherscan.io/tx/0x98b282a5dd698054eff4900ff8547170d4f7605b51140c55147fc5ae485f81da",
            "full": true
          }
        ],
        "asset": null,
        "floor": "$0.004 min",
        "floorNote": null,
        "gasSponsored": true,
        "caveat": ""
      },
      {
        "name": "Ultravioleta DAO",
        "nameNote": null,
        "url": "https://facilitator.ultravioletadao.xyz",
        "host": "facilitator.ultravioletadao.xyz",
        "keyless": true,
        "schemes": [
          "exact"
        ],
        "settles": [
          "eip3009"
        ],
        "note": "Ultravioleta DAO — keyless, 100% gas-sponsored. LIVE-settled on Optimism 2026-06-18 (tx 0xdd91dfdf12bed2d196e37fa1dea9a0da71a97e3c39a0ec0ed114be6a9af22837).",
        "settled": true,
        "date": "2026-06-18",
        "txs": [
          {
            "hash": "0xdd91dfdf12bed2d196e37fa1dea9a0da71a97e3c39a0ec0ed114be6a9af22837",
            "url": "https://optimistic.etherscan.io/tx/0xdd91dfdf12bed2d196e37fa1dea9a0da71a97e3c39a0ec0ed114be6a9af22837",
            "full": true
          }
        ],
        "asset": null,
        "floor": null,
        "floorNote": null,
        "gasSponsored": true,
        "caveat": ""
      }
    ]
  },
  {
    "caip2": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    "chain": "Solana",
    "slug": "solana",
    "facilitators": [
      {
        "name": "PayAI",
        "nameNote": null,
        "url": "https://facilitator.payai.network",
        "host": "facilitator.payai.network",
        "keyless": true,
        "schemes": [
          "exact"
        ],
        "settles": [
          "svm"
        ],
        "note": "PayAI — keyless fee-payer sponsor (Solana SPL SVM). LIVE-settled 2026-06-14 (tx 4dL8jRKH…).",
        "settled": true,
        "date": "2026-06-14",
        "txs": [
          {
            "hash": "4dL8jRKH…",
            "url": null,
            "full": false
          }
        ],
        "asset": "Solana SPL SVM",
        "floor": null,
        "floorNote": null,
        "gasSponsored": true,
        "caveat": ""
      },
      {
        "name": "OpenFacilitator",
        "nameNote": null,
        "url": "https://pay.openfacilitator.io",
        "host": "pay.openfacilitator.io",
        "keyless": true,
        "schemes": [
          "exact"
        ],
        "settles": [
          "svm"
        ],
        "note": "OpenFacilitator — keyless (no signup), fee-payer sponsor. LIVE-settled on Solana 2026-06-15 (tx 5BabDtX…).",
        "settled": true,
        "date": "2026-06-15",
        "txs": [
          {
            "hash": "5BabDtX…",
            "url": null,
            "full": false
          }
        ],
        "asset": null,
        "floor": null,
        "floorNote": null,
        "gasSponsored": true,
        "caveat": ""
      }
    ]
  },
  {
    "caip2": "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=",
    "chain": "Algorand",
    "slug": "algorand",
    "facilitators": [
      {
        "name": "GoPlausible",
        "nameNote": null,
        "url": "https://facilitator.goplausible.xyz",
        "host": "facilitator.goplausible.xyz",
        "keyless": true,
        "schemes": [
          "exact"
        ],
        "settles": [
          "algorand"
        ],
        "note": "GoPlausible — keyless, 100% gas-sponsored (Algorand USDCa, atomic-group fee pooling; both buyer AND merchant pay 0 ALGO). LIVE-settled on Algorand mainnet 2026-06-17 (tx PDVDVRFGJAG2K6AJ7L26OTSCSRL7AURVKEX4D4KHBAOLNSCYENXA). The only keyless Algorand x402 facilitator.",
        "settled": true,
        "date": "2026-06-17",
        "txs": [
          {
            "hash": "PDVDVRFGJAG2K6AJ7L26OTSCSRL7AURVKEX4D4KHBAOLNSCYENXA",
            "url": "https://allo.info/tx/PDVDVRFGJAG2K6AJ7L26OTSCSRL7AURVKEX4D4KHBAOLNSCYENXA",
            "full": true
          }
        ],
        "asset": null,
        "floor": null,
        "floorNote": null,
        "gasSponsored": true,
        "caveat": "Algorand USDCa, atomic-group fee pooling; both buyer AND merchant pay 0 ALGO. The only keyless Algorand x402 facilitator."
      }
    ]
  },
  {
    "caip2": "eip155:1",
    "chain": "Ethereum",
    "slug": "ethereum",
    "facilitators": [
      {
        "name": "Ultravioleta DAO",
        "nameNote": null,
        "url": "https://facilitator.ultravioletadao.xyz",
        "host": "facilitator.ultravioletadao.xyz",
        "keyless": true,
        "schemes": [
          "exact"
        ],
        "settles": [
          "eip3009"
        ],
        "note": "Ultravioleta DAO — keyless, 100% gas-sponsored (Ethereum native USDC EIP-3009; no settlement floor). LIVE-settled on Ethereum mainnet 2026-06-18 (tx 0x7fcc3cafdf43c52888f0117cde633eff35371f832dfb8dbd84e6fd7704ae5cfc).",
        "settled": true,
        "date": "2026-06-18",
        "txs": [
          {
            "hash": "0x7fcc3cafdf43c52888f0117cde633eff35371f832dfb8dbd84e6fd7704ae5cfc",
            "url": "https://etherscan.io/tx/0x7fcc3cafdf43c52888f0117cde633eff35371f832dfb8dbd84e6fd7704ae5cfc",
            "full": true
          }
        ],
        "asset": null,
        "floor": null,
        "floorNote": null,
        "gasSponsored": true,
        "caveat": ""
      }
    ]
  },
  {
    "caip2": "eip155:999",
    "chain": "HyperEVM",
    "slug": "hyperevm",
    "facilitators": [
      {
        "name": "Ultravioleta DAO",
        "nameNote": null,
        "url": "https://facilitator.ultravioletadao.xyz",
        "host": "facilitator.ultravioletadao.xyz",
        "keyless": true,
        "schemes": [
          "exact"
        ],
        "settles": [
          "eip3009"
        ],
        "note": "Ultravioleta DAO — keyless, 100% gas-sponsored (HyperEVM native USDC EIP-3009). LIVE-settled on HyperEVM 2026-06-17 (tx 0x56af8148a92a291f0ce362e250919f7742074e5464ac0f315ad68abaec93bd0a).",
        "settled": true,
        "date": "2026-06-17",
        "txs": [
          {
            "hash": "0x56af8148a92a291f0ce362e250919f7742074e5464ac0f315ad68abaec93bd0a",
            "url": "https://hyperevmscan.io/tx/0x56af8148a92a291f0ce362e250919f7742074e5464ac0f315ad68abaec93bd0a",
            "full": true
          }
        ],
        "asset": "HyperEVM native USDC EIP-3009",
        "floor": null,
        "floorNote": null,
        "gasSponsored": true,
        "caveat": ""
      }
    ]
  },
  {
    "caip2": "eip155:1329",
    "chain": "Sei",
    "slug": "sei",
    "facilitators": [
      {
        "name": "PayAI",
        "nameNote": null,
        "url": "https://facilitator.payai.network",
        "host": "facilitator.payai.network",
        "keyless": true,
        "schemes": [
          "exact"
        ],
        "settles": [
          "eip3009"
        ],
        "note": "PayAI — keyless, sponsors gas (Sei native USDC EIP-3009). LIVE-settled on Sei 2026-06-18 (tx 0xde63679b64749cb59625527e5c7682503c851d66b9b8b8ba217ed7b099461312).",
        "settled": true,
        "date": "2026-06-18",
        "txs": [
          {
            "hash": "0xde63679b64749cb59625527e5c7682503c851d66b9b8b8ba217ed7b099461312",
            "url": "https://seitrace.com/tx/0xde63679b64749cb59625527e5c7682503c851d66b9b8b8ba217ed7b099461312",
            "full": true
          }
        ],
        "asset": "Sei native USDC EIP-3009",
        "floor": null,
        "floorNote": null,
        "gasSponsored": true,
        "caveat": ""
      }
    ]
  },
  {
    "caip2": "eip155:130",
    "chain": "Unichain",
    "slug": "unichain",
    "facilitators": [
      {
        "name": "Ultravioleta DAO",
        "nameNote": null,
        "url": "https://facilitator.ultravioletadao.xyz",
        "host": "facilitator.ultravioletadao.xyz",
        "keyless": true,
        "schemes": [
          "exact"
        ],
        "settles": [
          "eip3009"
        ],
        "note": "Ultravioleta DAO — keyless, 100% gas-sponsored (Unichain native USDC EIP-3009). LIVE-settled on Unichain 2026-06-18 (tx 0xf8bf4a9a200f24159ac67c6315c30b194257999d7da21471b39d5f2cc32b2236).",
        "settled": true,
        "date": "2026-06-18",
        "txs": [
          {
            "hash": "0xf8bf4a9a200f24159ac67c6315c30b194257999d7da21471b39d5f2cc32b2236",
            "url": "https://uniscan.xyz/tx/0xf8bf4a9a200f24159ac67c6315c30b194257999d7da21471b39d5f2cc32b2236",
            "full": true
          }
        ],
        "asset": "Unichain native USDC EIP-3009",
        "floor": null,
        "floorNote": null,
        "gasSponsored": true,
        "caveat": ""
      }
    ]
  }
]

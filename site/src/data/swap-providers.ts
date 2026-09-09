// ⚠️ GENERATED. Do not edit by hand.
// Source: sdk/src/swapProviders.ts (SWAP_PROVIDERS)
// Regenerate: node site/scripts/gen-swap-providers.mjs
//
// Every entry is a swap route we settled a REAL mainnet transaction through, on the dated
// day, and then verified by reading it back from a public node. Never seeded from a
// documentation page: a quote proves routing, only a transaction proves settlement.

export interface SwapProofView {
  network: string
  tx: string
  date: string
  summary: string
  covers?: string
  chain: string
  slug: string
  url: string
  short: string
}
export interface SwapChainView {
  caip2: string
  name: string
  slug: string
  explorer: string
}
export interface SwapProviderView {
  id: string
  /** Filename inside /swaps/, extension resolved from disk (svg or webp). */
  logo: string
  name: string
  /** 'protocol' = the ledger itself swaps, no third party. 'provider' = a named router. */
  kind: 'protocol' | 'provider'
  url: string
  host: string
  keyless: boolean
  fee: string
  mechanism: string
  /** Set only when the route ships WITHOUT a mainnet proof, naming the reason. */
  unproven?: string
  chains: SwapChainView[]
  proofs: SwapProofView[]
}

export const SWAP_PROVIDERS: SwapProviderView[] = [
  {
    "id": "stellar-sdex",
    "logo": "stellar-sdex.svg",
    "name": "Stellar SDEX",
    "kind": "protocol",
    "url": "https://developers.stellar.org/docs/build/guides/transactions/path-payments",
    "host": "developers.stellar.org",
    "keyless": true,
    "fee": "No trading fee on the order books (spread only); the protocol liquidity pools charge a fixed 0.30%. Nobody can add an integrator fee, because there is no field for one.",
    "mechanism": "A PathPaymentStrictReceive addressed to your own account: one atomic operation, routed across the order books and liquidity pools.",
    "chains": [
      {
        "caip2": "stellar:pubnet",
        "name": "Stellar",
        "slug": "stellar",
        "explorer": "https://stellar.expert/explorer/public/tx/"
      }
    ],
    "proofs": [
      {
        "network": "stellar:pubnet",
        "tx": "f7b784d4758ea83a022921c7202051b4643fefb4fa61530a49010a4a9348a0aa",
        "date": "2026-09-08",
        "summary": "0.2652 XLM → 0.05 USDC",
        "covers": "native in, and the ledger records source and destination as the same account",
        "chain": "Stellar",
        "slug": "stellar",
        "url": "https://stellar.expert/explorer/public/tx/f7b784d4758ea83a022921c7202051b4643fefb4fa61530a49010a4a9348a0aa",
        "short": "f7b784d4…a0aa"
      },
      {
        "network": "stellar:pubnet",
        "tx": "3aa2ca9e35ff7d7c3d0aaff3b24d53b4d2ea009067debf058c30ed8cad445f03",
        "date": "2026-09-08",
        "summary": "USDC → 0.2 XLM",
        "covers": "the reverse direction, token in",
        "chain": "Stellar",
        "slug": "stellar",
        "url": "https://stellar.expert/explorer/public/tx/3aa2ca9e35ff7d7c3d0aaff3b24d53b4d2ea009067debf058c30ed8cad445f03",
        "short": "3aa2ca9e…5f03"
      },
      {
        "network": "stellar:pubnet",
        "tx": "27f50b2c2c57a64a8b50c1b14f310ec99b4ccbbb4bc72c479a5f6f9f1180e385",
        "date": "2026-09-08",
        "summary": "0.1064 XLM → 0.02 USDC",
        "covers": "run straight from the committed example, so the documented flow is proven too",
        "chain": "Stellar",
        "slug": "stellar",
        "url": "https://stellar.expert/explorer/public/tx/27f50b2c2c57a64a8b50c1b14f310ec99b4ccbbb4bc72c479a5f6f9f1180e385",
        "short": "27f50b2c…e385"
      }
    ]
  },
  {
    "id": "xrpl-dex",
    "logo": "xrpl-dex.svg",
    "name": "XRPL DEX + AMM",
    "kind": "protocol",
    "url": "https://xrpl.org/docs/concepts/tokens/decentralized-exchange/automated-market-makers",
    "host": "xrpl.org",
    "keyless": true,
    "fee": "No protocol fee on the order books (spread only); AMM pools charge a per-pool fee set by liquidity providers, 0% to 1%, paid to the pool. No integrator fee is expressible.",
    "mechanism": "A cross-currency Payment addressed to your own account, which the ledger permits precisely for currency conversion. Auto-bridged through XRP where that is cheaper.",
    "chains": [
      {
        "caip2": "xrpl:0",
        "name": "XRP Ledger",
        "slug": "xrpl",
        "explorer": "https://xrpscan.com/tx/"
      }
    ],
    "proofs": [
      {
        "network": "xrpl:0",
        "tx": "F703B271E35BD3C2408DB64F693461513DD5166C15EC61DBAB0B2A9F726ED97E",
        "date": "2026-09-08",
        "summary": "0.072 XRP → 0.1 RLUSD",
        "covers": "native in; delivered_amount matched the requested amount exactly",
        "chain": "XRP Ledger",
        "slug": "xrpl",
        "url": "https://xrpscan.com/tx/F703B271E35BD3C2408DB64F693461513DD5166C15EC61DBAB0B2A9F726ED97E",
        "short": "F703B271…D97E"
      },
      {
        "network": "xrpl:0",
        "tx": "24EC9DDD2B5D00FD7CD56882999FCF59ABC274AA32E35119EADE397B335EEB63",
        "date": "2026-09-08",
        "summary": "RLUSD → 0.02 XRP",
        "covers": "the reverse direction, token in",
        "chain": "XRP Ledger",
        "slug": "xrpl",
        "url": "https://xrpscan.com/tx/24EC9DDD2B5D00FD7CD56882999FCF59ABC274AA32E35119EADE397B335EEB63",
        "short": "24EC9DDD…EB63"
      }
    ]
  },
  {
    "id": "jupiter",
    "logo": "jupiter.svg",
    "name": "Jupiter",
    "kind": "provider",
    "url": "https://jup.ag",
    "host": "jup.ag",
    "keyless": true,
    "fee": "No platform fee. Verified per quote rather than assumed: PipRail never sets platformFeeBps, and every quote is inspected so the note says so if one ever appears.",
    "mechanism": "Jupiter routes and builds a serialized transaction; your own keypair signs it locally and this process broadcasts it. Jupiter never signs and never holds the funds.",
    "chains": [
      {
        "caip2": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
        "name": "Solana",
        "slug": "solana",
        "explorer": "https://solscan.io/tx/"
      }
    ],
    "proofs": [
      {
        "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
        "tx": "2rXpQYVerRzrwUfmXMYcm6ijkm8x7LHU91onSZjrng34kr1nfcxZj1A8Ek7inSw7ZBzk3phAaYnvHwdSJTKxJ4rq",
        "date": "2026-09-08",
        "summary": "0.1031 USDC → 0.001 SOL",
        "covers": "token in, exact output",
        "chain": "Solana",
        "slug": "solana",
        "url": "https://solscan.io/tx/2rXpQYVerRzrwUfmXMYcm6ijkm8x7LHU91onSZjrng34kr1nfcxZj1A8Ek7inSw7ZBzk3phAaYnvHwdSJTKxJ4rq",
        "short": "2rXpQYVe…J4rq"
      },
      {
        "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
        "tx": "UEeXBp3sPZgEHmahMasAbFhbTootXGCcpoNh7bN1sWsjoPDc1QE7uGaHjivT3iTroxLVJeWGVp2jZT63d2BVTk5",
        "date": "2026-09-08",
        "summary": "0.000485 SOL → 0.05 USDC",
        "covers": "the reverse direction, native in",
        "chain": "Solana",
        "slug": "solana",
        "url": "https://solscan.io/tx/UEeXBp3sPZgEHmahMasAbFhbTootXGCcpoNh7bN1sWsjoPDc1QE7uGaHjivT3iTroxLVJeWGVp2jZT63d2BVTk5",
        "short": "UEeXBp3s…VTk5"
      }
    ]
  },
  {
    "id": "kyberswap",
    "logo": "kyberswap.svg",
    "name": "KyberSwap",
    "kind": "provider",
    "url": "https://kyberswap.com",
    "host": "kyberswap.com",
    "keyless": true,
    "fee": "No integrator fee. Verified per quote rather than assumed: PipRail sends no fee parameters, and the returned extraFee block is inspected so the note says so if one ever appears.",
    "mechanism": "KyberSwap routes; your own wallet calls the router contract directly. An ERC-20 swap costs two transactions (an approve, then the swap); a native-in swap costs one.",
    "chains": [
      {
        "caip2": "eip155:1",
        "name": "Ethereum",
        "slug": "ethereum",
        "explorer": "https://etherscan.io/tx/"
      },
      {
        "caip2": "eip155:10",
        "name": "Optimism",
        "slug": "optimism",
        "explorer": "https://optimistic.etherscan.io/tx/"
      },
      {
        "caip2": "eip155:56",
        "name": "BNB Chain",
        "slug": "bnb",
        "explorer": "https://bscscan.com/tx/"
      },
      {
        "caip2": "eip155:137",
        "name": "Polygon",
        "slug": "polygon",
        "explorer": "https://polygonscan.com/tx/"
      },
      {
        "caip2": "eip155:8453",
        "name": "Base",
        "slug": "base",
        "explorer": "https://basescan.org/tx/"
      },
      {
        "caip2": "eip155:42161",
        "name": "Arbitrum",
        "slug": "arbitrum",
        "explorer": "https://arbiscan.io/tx/"
      },
      {
        "caip2": "eip155:43114",
        "name": "Avalanche",
        "slug": "avalanche",
        "explorer": "https://snowtrace.io/tx/"
      },
      {
        "caip2": "eip155:59144",
        "name": "Linea",
        "slug": "linea",
        "explorer": "https://lineascan.build/tx/"
      },
      {
        "caip2": "eip155:4663",
        "name": "Robinhood",
        "slug": "robinhood",
        "explorer": "https://robinhoodchain.blockscout.com/tx/"
      }
    ],
    "proofs": [
      {
        "network": "eip155:56",
        "tx": "0x1748b6b27b1920aafd1d2730d250378b08cd4c0851a29e5e785dea960e0c8d4d",
        "date": "2026-09-08",
        "summary": "0.0101 USDT → USDC on BNB Chain",
        "covers": "the ERC-20 path, which needs an approval first",
        "chain": "BNB Chain",
        "slug": "bnb",
        "url": "https://bscscan.com/tx/0x1748b6b27b1920aafd1d2730d250378b08cd4c0851a29e5e785dea960e0c8d4d",
        "short": "0x1748b6…8d4d"
      },
      {
        "network": "eip155:4663",
        "tx": "0x424299e67be623313c679e659fbfe9fb8707800fe145cddf7fac5a9bdbb78f10",
        "date": "2026-09-08",
        "summary": "native ETH → 0.360518 USDG on Robinhood Chain",
        "covers": "a 100ms-block chain, where a route goes stale fast: the default 50 bps slippage reverted first, 300 bps cleared",
        "chain": "Robinhood",
        "slug": "robinhood",
        "url": "https://robinhoodchain.blockscout.com/tx/0x424299e67be623313c679e659fbfe9fb8707800fe145cddf7fac5a9bdbb78f10",
        "short": "0x424299…8f10"
      },
      {
        "network": "eip155:56",
        "tx": "0xe27f957b40285acf0b846aea23808d49cc6a44fccd755aa88656abf31204fb00",
        "date": "2026-09-08",
        "summary": "native BNB → 0.02 USDC",
        "covers": "the native-in path, which needs no approval",
        "chain": "BNB Chain",
        "slug": "bnb",
        "url": "https://bscscan.com/tx/0xe27f957b40285acf0b846aea23808d49cc6a44fccd755aa88656abf31204fb00",
        "short": "0xe27f95…fb00"
      },
      {
        "network": "eip155:8453",
        "tx": "0xb28b802f530945eba1ea1662890792bfa1dfba64f5094caa58297f9693604032",
        "date": "2026-09-08",
        "summary": "0.00117 USDC → EURC on Base",
        "covers": "a second EVM chain on the same implementation",
        "chain": "Base",
        "slug": "base",
        "url": "https://basescan.org/tx/0xb28b802f530945eba1ea1662890792bfa1dfba64f5094caa58297f9693604032",
        "short": "0xb28b80…4032"
      },
      {
        "network": "eip155:8453",
        "tx": "0x99a0842cd6c3fb33ddc03ddf776c2981c629debcd8ac47678a2e5e29e4496242",
        "date": "2026-09-08",
        "summary": "EURC → USDC on Base",
        "covers": "the reverse direction",
        "chain": "Base",
        "slug": "base",
        "url": "https://basescan.org/tx/0x99a0842cd6c3fb33ddc03ddf776c2981c629debcd8ac47678a2e5e29e4496242",
        "short": "0x99a084…6242"
      }
    ]
  },
  {
    "id": "aftermath",
    "logo": "aftermath.webp",
    "name": "Aftermath",
    "kind": "provider",
    "url": "https://aftermath.finance",
    "host": "aftermath.finance",
    "keyless": true,
    "fee": "No fee added by the router: the route reports its own coinIn/coinOut tradeFee as zero, and the only cost is the underlying pool fee (about 0.014% on the probed route). PipRail passes no fee parameter.",
    "mechanism": "Aftermath routes and returns a COMPLETE serialized programmable transaction block; your own keypair signs it locally and this process broadcasts it. It never signs and never holds the funds.",
    "chains": [
      {
        "caip2": "sui:mainnet",
        "name": "Sui",
        "slug": "sui",
        "explorer": "https://suiscan.xyz/mainnet/tx/"
      }
    ],
    "proofs": [
      {
        "network": "sui:mainnet",
        "tx": "GtykrnLxejyrjmTL8oKVoEtTAiP9eY69CGne7Djw3Cha",
        "date": "2026-09-08",
        "summary": "0.0657 SUI to 0.0505 USDC",
        "covers": "native in; the balance changes on chain match the quote exactly",
        "chain": "Sui",
        "slug": "sui",
        "url": "https://suiscan.xyz/mainnet/tx/GtykrnLxejyrjmTL8oKVoEtTAiP9eY69CGne7Djw3Cha",
        "short": "GtykrnLx…3Cha"
      }
    ]
  },
  {
    "id": "ref-finance",
    "logo": "ref-finance.webp",
    "name": "Ref Finance",
    "kind": "provider",
    "url": "https://app.ref.finance",
    "host": "app.ref.finance",
    "keyless": true,
    "fee": "The pool's own total_fee, read live per pool (0.01% on the route used). There is no integrator fee for PipRail to set or waive.",
    "mechanism": "One ft_transfer_call receipt chain: token contract to AMM and back to you, inside a single transaction you sign. No solver takes possession, which is exactly why this is used instead of an intent network.",
    "chains": [
      {
        "caip2": "near:mainnet",
        "name": "NEAR",
        "slug": "near",
        "explorer": "https://nearblocks.io/txns/"
      }
    ],
    "proofs": [
      {
        "network": "near:mainnet",
        "tx": "FAb28z1tCcecd2teFTxJGkgaLMr1mpctuiFhUeCKjszT",
        "date": "2026-09-08",
        "summary": "0.0505 USDT to 0.05 USDC",
        "covers": "token to token across a stable pool, 14 receipts, all successful",
        "chain": "NEAR",
        "slug": "near",
        "url": "https://nearblocks.io/txns/FAb28z1tCcecd2teFTxJGkgaLMr1mpctuiFhUeCKjszT",
        "short": "FAb28z1t…jszT"
      }
    ]
  },
  {
    "id": "vestige",
    "logo": "vestige.webp",
    "name": "Vestige",
    "kind": "provider",
    "url": "https://vestige.fi",
    "host": "vestige.fi",
    "keyless": true,
    "fee": "The pool's own fee (0.30% on the probed route) plus the group's network fee. PipRail sends no fee parameter.",
    "mechanism": "Vestige returns an UNSIGNED atomic transaction group in which every signer is you. The SDK asserts that at runtime before signing anything, then signs locally and submits.",
    "chains": [
      {
        "caip2": "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=",
        "name": "Algorand",
        "slug": "algorand",
        "explorer": "https://allo.info/tx/"
      }
    ],
    "proofs": [
      {
        "network": "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=",
        "tx": "5UV7SWSJODHJDGMXODTOMBNXMK4YGZIZKR4VOM6XHML7JS7A32UA",
        "date": "2026-09-08",
        "summary": "0.5094 ALGO to 0.05 USDC",
        "covers": "a four-transaction atomic group, every signer the sender",
        "chain": "Algorand",
        "slug": "algorand",
        "url": "https://allo.info/tx/5UV7SWSJODHJDGMXODTOMBNXMK4YGZIZKR4VOM6XHML7JS7A32UA",
        "short": "5UV7SWSJ…32UA"
      }
    ]
  },
  {
    "id": "hyperion",
    "logo": "hyperion.webp",
    "name": "Hyperion",
    "kind": "provider",
    "url": "https://hyperion.xyz",
    "host": "hyperion.xyz",
    "keyless": true,
    "fee": "The pool's own fee, read off-chain-state per route (0.01% on the stable pool used here). No API key, no integrator fee: the entry function has no fee parameter to set.",
    "mechanism": "Called contract-to-contract with NO API in the middle: the quote is an on-chain `view` and the swap is a Move entry function your own account signs. Uniquely, `exact_output_swap_entry` takes the amount you want OUT plus an on-chain input cap, so an x402 invoice is priced exactly rather than approximated.",
    "chains": [
      {
        "caip2": "aptos:1",
        "name": "Aptos",
        "slug": "aptos",
        "explorer": "https://explorer.aptoslabs.com/txn/"
      }
    ],
    "proofs": [
      {
        "network": "aptos:1",
        "tx": "0x927293cf8584320f1e265c564ab3096262b675a61996e0da955a2b3c27af1adc",
        "date": "2026-09-08",
        "summary": "0.049997 USDC to exactly 0.05 USDT",
        "covers": "the stable pair, and the first swap in this SDK to deliver an EXACT output rather than at-least",
        "chain": "Aptos",
        "slug": "aptos",
        "url": "https://explorer.aptoslabs.com/txn/0x927293cf8584320f1e265c564ab3096262b675a61996e0da955a2b3c27af1adc",
        "short": "0x927293…1adc"
      },
      {
        "network": "aptos:1",
        "tx": "0xae849e031cb50a660f8c9f286c1f3a9caeff08b427efd9428154d884f1e3059e",
        "date": "2026-09-08",
        "summary": "0.040012 USDT to exactly 0.04 USDC",
        "covers": "the reverse direction, which takes the opposite on-chain price bound",
        "chain": "Aptos",
        "slug": "aptos",
        "url": "https://explorer.aptoslabs.com/txn/0xae849e031cb50a660f8c9f286c1f3a9caeff08b427efd9428154d884f1e3059e",
        "short": "0xae849e…059e"
      },
      {
        "network": "aptos:1",
        "tx": "0x7921118d64ce1e4ebe7911ed22fef2222597e1b9e20caf0fd4f89bce07c07981",
        "date": "2026-09-08",
        "summary": "0.0459 APT to exactly 0.03 USDC",
        "covers": "native APT in, on a different fee tier",
        "chain": "Aptos",
        "slug": "aptos",
        "url": "https://explorer.aptoslabs.com/txn/0x7921118d64ce1e4ebe7911ed22fef2222597e1b9e20caf0fd4f89bce07c07981",
        "short": "0x792111…7981"
      },
      {
        "network": "aptos:1",
        "tx": "0x640bce4b1e5f688d4494d0c343247b2951d22bc26d371b81f7d2c04655a7a707",
        "date": "2026-09-08",
        "summary": "0.012842 USDC to exactly 0.02 APT",
        "covers": "native APT out, where the balance delta nets off gas and only the deposit event proves the exact amount",
        "chain": "Aptos",
        "slug": "aptos",
        "url": "https://explorer.aptoslabs.com/txn/0x640bce4b1e5f688d4494d0c343247b2951d22bc26d371b81f7d2c04655a7a707",
        "short": "0x640bce…a707"
      }
    ]
  },
  {
    "id": "stonfi",
    "logo": "stonfi.webp",
    "name": "STON.fi",
    "kind": "provider",
    "url": "https://ston.fi",
    "host": "ston.fi",
    "keyless": true,
    "fee": "The pool's own fee, reported per route by the simulation (about 0.10% on the routes used here). No API key and no referral field.",
    "mechanism": "Exact-output route, priced by STON.fi's keyless `reverse_swap` simulation, which fixes the ASK side and returns the offer required. PipRail pads the request so the router's on-chain floor (`min_ask_units`) is at or above the invoice: you may receive slightly more, never less. The swap is one message your own wallet signs to the router the simulation named. TON settles asynchronously, so arrival is a balance check rather than one atomic receipt.",
    "chains": [
      {
        "caip2": "tvm:-239",
        "name": "TON",
        "slug": "ton",
        "explorer": "https://tonviewer.com/transaction/"
      }
    ],
    "proofs": [
      {
        "network": "tvm:-239",
        "tx": "1f6d58d073bd988b47272658297ebabc4748725ca919a4a9c863f28cef8eeb3f",
        "date": "2026-09-08",
        "summary": "0.035528 TON for 0.05 USDT",
        "covers": "native TON in, through the pTON proxy jetton, on the v2.2 router. The wallet transaction that STARTED the swap (opcode 0x01f3835d), not the gas refund that lands moments later",
        "chain": "TON",
        "slug": "ton",
        "url": "https://tonviewer.com/transaction/1f6d58d073bd988b47272658297ebabc4748725ca919a4a9c863f28cef8eeb3f",
        "short": "1f6d58d0…eb3f"
      },
      {
        "network": "tvm:-239",
        "tx": "f76ae97e107b7852ea105d3b3b0caf095ec77bd2541f40417303c08566a87947",
        "date": "2026-09-08",
        "summary": "0.028171 USDT for 0.02 TON",
        "covers": "the jetton-to-TON direction, which the simulation routed through a DIFFERENT router version (v2.1). A TEP-74 jetton transfer (opcode 0x0f8a7ea5) carrying the swap as its forward payload",
        "chain": "TON",
        "slug": "ton",
        "url": "https://tonviewer.com/transaction/f76ae97e107b7852ea105d3b3b0caf095ec77bd2541f40417303c08566a87947",
        "short": "f76ae97e…7947"
      }
    ]
  },
  {
    "id": "sunswap",
    "logo": "sunswap.webp",
    "name": "SunSwap V2",
    "kind": "provider",
    "url": "https://sunswap.com",
    "host": "sunswap.com",
    "keyless": true,
    "fee": "The pool's own 0.30% constant-product fee. No API key and no integrator fee: the router has no such parameter. Tron's ENERGY charge is the dominant cost, see below.",
    "mechanism": "Called contract-to-contract with NO API: `getAmountsIn` prices an exact output and `swapETHForExactTokens` executes it with the input capped on-chain. Selling native TRX is one transaction; selling a TRC-20 is two, because the router moves the input with `transferFrom` and needs an approval first. SunSwap's own front end uses an undocumented, obfuscated hostname, which a payments SDK should not depend on, so this skips the service entirely.",
    "unproven": "Shipped without a mainnet proof, deliberately and openly. The route is real, and every part of it that can be checked without spending has been: both directions quote live through the SDK, and the approve and the router call both execute cleanly in constant-call simulations against the real contracts. It has NOT been broadcast because Tron charges about 230,629 ENERGY per swap, which without staked energy is roughly 23 TRX (about $7.79) regardless of trade size, plus about 10 TRX more the first time a TRC-20 is approved. The project test wallets hold 8.1 TRX. A user with energy can swap today; we simply have not paid to prove it.",
    "chains": [
      {
        "caip2": "tron:mainnet",
        "name": "Tron",
        "slug": "tron",
        "explorer": "https://tronscan.org/#/transaction/"
      }
    ],
    "proofs": []
  }
]

/** Routes where the LEDGER swaps and no third party is involved. */
export const PROTOCOL_COUNT = 2
/** Routes handled by a named third-party router. */
export const PROVIDER_COUNT = 8
/** Distinct chains with a proven swap route. */
export const SWAP_CHAIN_COUNT = 18
/** Real mainnet transactions backing the table. */
export const SWAP_PROOF_COUNT = 21

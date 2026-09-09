# Swap: hold the wrong token, get the right one

An **optional** helper. Nothing in PipRail swaps by itself: paying never swaps, planning
never swaps, and there is no `autoSwap` flag. If you never call `quoteSwap()`, this feature
does not exist for you, and that is a supported way to use the SDK.

```bash
npm install
WALLET_KEY=… npm run quote    # read-only, signs nothing
WALLET_KEY=… npm run swap     # executes the quote you just saw
```

## The shape: look first, then commit

`quoteSwap()` reads and **never throws for a read problem** (`null` means no quote, never no
funds). The one exception is a malformed `slippageBps`, which throws a `RangeError` before any
read, because that is a bug in your code rather than a market condition. `swap()` is the only
call that moves anything.

## Where it works

| Tier | Chains | Who swaps |
|---|---|---|
| `protocol` | Stellar, XRP Ledger | **the ledger itself** (Stellar SDEX, XRPL DEX + AMM), no third party |
| `provider` | Solana, the EVM chains, Sui, NEAR, Algorand, Aptos, TON, Tron | a named keyless venue (Jupiter, KyberSwap, Aftermath, Ref Finance, Vestige, Hyperion, STON.fi, SunSwap V2) |

**Every driver family can swap.** Coverage is still per-chain rather than universal, so on a
chain with no route `quoteSwap()` returns `null` and `swap()` throws, naming the venues that do
exist. The current list is data you can read: `import { SWAP_PROVIDERS } from '@piprail/sdk'`, or
browse it at [piprail.com/swaps](https://piprail.com/swaps).

On Aptos and Tron there is no API in the middle at all: the quote is an on-chain read and the
swap is a contract call your own key signs.

## Two things to know

1. **Your spend policy does not govern swaps.** Every budget cap governs paying a merchant.
2. **There is deliberately no MCP tool for this**, which follows from the first point.

Full detail: [docs.piprail.com/making-payments/swapping](https://docs.piprail.com/making-payments/swapping/)

# Multi-chain buyer — one wallet per chain, pay whatever the 402 asks

A `PipRailClient` is bound to **one chain and one wallet**. That's deliberate: an
EVM private key can't sign a Solana transaction, an XRPL seed can't sign on Base —
keys are chain-family-specific. So how does a buyer pay a merchant that wants
**whatever chain it happens to demand**?

You give the buyer **one wallet per chain** and let `MultiChainPayer` route.

```
            ┌─────────────────────────  MultiChainPayer  ─────────────────────────┐
            │  base   → PipRailClient({ chain:'base',   wallet:{ privateKey }})    │
   one  ───▶│  polygon→ PipRailClient({ chain:'polygon',wallet:{ privateKey }})    │
   buyer    │  solana → PipRailClient({ chain:'solana', wallet:{ secretKey  }})    │
            └──────────────────────────────────┬──────────────────────────────────┘
                                                │  payer.get(url)
                                                ▼
                        GET /api/report  ──▶  402  accepts: [ Base-USDC,
                                                              Polygon-USDC,
                                                              Arbitrum-USDC ]
                                                │
              plan every chain you hold ◀───────┘   (balance + gas + recipient-ready)
              pick the FIRST you can settle    ──▶  pay on THAT chain only
```

Under the hood it's the SDK's two cross-chain primitives — `planAcross` (survey
every chain, ranked payable-first in the order you listed them) and `fetchAcross`
(pay on the owning client of the chosen rail). Every payment still goes through that
chain's own spend policy, approval hook, retries, and replay-protection. **No price
oracle, no backend, no custody** — across chains the **first one you list** that can
settle wins (your preference; base-unit gas isn't comparable across different native
coins, and there's no oracle), and *within* a chain the cheapest-gas rail wins.

## Run it

```bash
npm install

# 1) Start the merchant — ONE 402 offering 0.05 USDC on Base, Polygon, AND Arbitrum.
PAY_TO_EVM=0xYourMerchantWallet npm run merchant

# 2) In another terminal, the buyer. One EVM key works on every EVM chain.
#    Plan first (read-only — moves nothing, just shows the cross-chain survey):
EVM_KEY=0xYourBuyerKey node buyer.mjs http://127.0.0.1:3000/api/report

#    Then actually settle it on the first funded chain that can pay:
EVM_KEY=0xYourBuyerKey node buyer.mjs http://127.0.0.1:3000/api/report --pay
```

### What the buyer prints (the read-only plan)

```
Buyer wallets : base, polygon, arbitrum
Target URL    : http://127.0.0.1:3000/api/report

PLAN: READY
  rail (network · token)             state    gas                amount
  ──────────────────────────────────────────────────────────────────────────────
  eip155:8453 · USDC                 payable  0.000021 ETH       0.05 USDC  ◀ best
  eip155:137 · USDC                  payable  0.012 POL          0.05 USDC
  eip155:42161 · USDC                payable  0.000004 ETH       0.05 USDC

(Read-only plan above. Re-run with --pay to settle the chosen rail.)
```

One endpoint, three rails — the payer surveyed every chain it holds a key for, saw it
could settle on all three, and chose **Base** because the buyer listed it first (not
because it's cheapest — note Arbitrum's gas is numerically smaller, but ETH-gas and
POL-gas aren't comparable without an oracle). Reorder the wallets to put `arbitrum`
first and it wins instead. `--pay` then settles **only** the chosen rail and unlocks
the response.

## Add a different chain FAMILY (Solana, XRPL, …)

Cross-family is the same idea — just a different key shape and that family's peer
libs. Install them, then set the key:

```bash
npm install @solana/web3.js @solana/spl-token bs58      # Solana
npm install xrpl                                        # XRP Ledger

SOLANA_KEY=<base58-secret> XRPL_SEED=s… EVM_KEY=0x… \
  node buyer.mjs http://127.0.0.1:3000/api/report
```

Add a matching rail to the merchant's `accept: [...]` (e.g.
`{ chain: 'solana', token: 'USDC', amount: '0.05', payTo: '<your-solana-addr>' }`)
and a Solana-funded buyer can now pay it — the EVM buyer still pays on EVM. Same
endpoint, every buyer pays on a chain it actually holds.

## Zero-code agents: the MCP equivalent

The `@piprail/mcp` server does this for any AI client. Instead of one
`PIPRAIL_CHAIN` + `PIPRAIL_PRIVATE_KEY`, list several chains and give each its own key:

```jsonc
{
  "command": "npx",
  "args": ["-y", "@piprail/mcp"],
  "env": {
    "PIPRAIL_CHAINS": "base,polygon,solana",
    "PIPRAIL_BASE_KEY": "0x…",
    "PIPRAIL_POLYGON_KEY": "0x…",
    "PIPRAIL_SOLANA_KEY": "<base58-secret>",
    "PIPRAIL_MAX_AMOUNT": "1.00"
  }
}
```

The model's `piprail_pay_request` tool now pays whichever chain a 402 asks for —
one server, one budget, every chain you funded. See
[docs.piprail.com/mcp](https://docs.piprail.com/mcp/overview/).

## How a single client behaves (the thing this solves)

Point a single-chain client at a 402 it can't settle and it tells you exactly why,
naming the chains the 402 *is* payable on:

```
NoCompatibleAcceptError: No accepts[] entry payable by this client on eip155:8453
  (schemes: onchain-proof; challenge offered: solana:mainnet).
```

`MultiChainPayer` is how you hold the keys to answer that — without giving up the
one-key-per-family safety the SDK enforces underneath.

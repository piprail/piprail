# Nano x402 rail

A merchant that answers the same 402 payment challenge on **two rails**: EVM-USDC
(via PipRail, unchanged) and **Nano / XNO** (via the @x402nano/exact scheme).
Nano settles feeless and sub-second, with no stablecoin approve and no gas auction.

```
            402 challenge
  GET /api/report-nano   (exact, nano:mainnet)   -> pay 0.001 XNO, feeless
  GET /api/report-usdc   (PipRail, base)         -> pay 0.05 USDC, ~$0.06 gas
```

A caller holds whichever wallet it has. Same protocol shape (402 → challenge →
signed proof → retry), just a cheaper rail on the Nano side.

## Why Nano as x402 settlement

|                        | Nano (XNO)                        | EVM-USDC (Base)            |
| ---------------------- | --------------------------------- | -------------------------- |
| Fee per transfer       | **0** (no gas, no approve)        | ~$0.02-0.06 gas            |
| Finality               | **~0.3 s** (the block is it)      | ~3-12 s (block + confirm)  |
| Custody                | self-custody, no freeze           | self-custody, stablecoin   |

Nano has no issuer that can freeze funds, no bridge, and no off-chain batching
risk. The exact-scheme proof (a Nano send block) is verified by a facilitator
the merchant trusts, exactly like a USDC onchain proof.

## Run it

```bash
npm install
NANO_PAY_TO=nano_3YourWallet… node merchant.mjs
```

Then watch the two rails:

```bash
curl http://127.0.0.1:3000/health            # both rails advertised
curl http://127.0.0.1:3000/api/report-nano   # -> 402 + nano:mainnet exact accept
curl http://127.0.0.1:3000/api/report-usdc   # -> 402 + PipRail USDC accept
```

Pay the Nano rail with a real Nano key:

```bash
NANO_CLIENT_KEY=… node buyer.mjs http://127.0.0.1:3000/api/report-nano
```

### Keyless note

`npm test` runs a self-check with **zero real money**: it starts the merchant on
an isolated port and asserts both rails return a proper 402 challenge (the Nano
rail advertising a `nano:mainnet` exact accept). It does not settle on the live
network. To settle for real you need a funded Nano key and a facilitator that
verifies/settles Nano (run the x402nano/exact facilitator example, or point
`FACILITATOR_URL` at one).

## What's reused (not rebuilt)

- **`@x402nano/exact`** (MIT) — the exact-scheme client/server for Nano
  https://github.com/x402nano/exact
- **`@x402nano/helper`** — Nano RPC + work-generation helper
- **`@piprail/sdk`** — the existing EVM-USDC rail, untouched

No Nano payment logic is rebuilt here: this is a thin, documented example that
plugs an existing Nano x402 scheme next to an existing PipRail rail.

## Next

- A reviewer agrees the Nano rail is worth a first-class `drivers/nano/` family
  in the SDK (piprail/piprail#125) — the smallest fold-in keeps the merchant
  example above and adds the driver mirroring the existing `chains · wallet ·
  pay · verify · index` shape.

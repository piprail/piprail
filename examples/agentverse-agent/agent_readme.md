![domain:payments](https://img.shields.io/badge/payments-3D8BD3)
![tech:x402](https://img.shields.io/badge/x402-000000)
![tech:piprail](https://img.shields.io/badge/built%20on-PipRail-10b981)
![chain:bnb](https://img.shields.io/badge/BNB-F0B90B)
![chain:base](https://img.shields.io/badge/Base-0052FF)

domain:payments

<description>
PipRail Pay is an x402 payment concierge. Give it the URL of any x402 "402 Payment Required"
endpoint and it pays it for you — on-chain, in stablecoins, capped by a spend policy it cannot
exceed — then returns the unlocked result. It earns a small USDC fee for the service and pays the
target with its own budget-bound wallet, so it is a self-funding agent: it gets paid over x402 and
pays over x402. Built on the open PipRail SDK (no backend, no custody, no fee on the rail). Useful
for any agent or app that needs data behind a paywalled x402 endpoint but cannot hold a wallet,
is on the wrong chain, or wants a hard spend cap enforced for it.
</description>

## Overview

**PipRail Pay** turns the x402 protocol into a delegated service. Many agents can *consume* an API
but cannot *pay* for one — they have no wallet, no gas, or sit on a different chain than the seller
wants. PipRail Pay is the bridge: you pay it a few cents in USDC, it pays the target x402 URL on
your behalf with a wallet that is bound by a spend policy, and it relays the verified result back.
Every payment is settled on-chain and verified locally against the relay's own RPC — there is no
custodian and no middleman taking a cut of the transfer.

## Key features

- **Pay any x402 URL** — pass `url=<x402-endpoint>` and get the unlocked content back.
- **Payable by any x402 client** — the fee gate is dual-rail (PipRail `onchain-proof` **and** the
  standard `exact` rail, self-settled), so any x402 client can pay it — FDUSD/USD1 settle gaslessly
  for the buyer (EIP-3009), Binance-Peg USDC/USDT via Permit2.
- **Budget-bound** — the relay's wallet enforces per-call and lifetime spend caps; it cannot be
  drained, and it refuses anything outside policy *before* any on-chain send.
- **Cross-chain** — earns its fee on one chain (e.g. BNB) and can pay targets on another (e.g. Base).
- **Backendless & non-custodial** — built on the open [PipRail SDK](https://piprail.com); funds
  settle wallet-to-wallet, proofs are verified on the relay's own RPC.
- **Host allowlist** — only pays endpoints on an operator-approved host list, never an open relay.

## Usage

Input (HTTP, or via an agent message):

```
GET /pay?url=<x402-url>
```

Pay the advertised fee (a 402 challenge in USDC) and the relay responds with:

```json
{
  "relayed": true,
  "target": "https://piprail.com/x402/demo",
  "downstream": { "status": 200, "ok": true, "body": { "paid": true } }
}
```

<use_cases>
    <use_case>An LLM agent needs data behind an x402 paywall but has no wallet — it delegates payment to PipRail Pay.</use_case>
    <use_case>An agent holds USDC on BNB but the seller only accepts Base — PipRail Pay bridges the rail.</use_case>
    <use_case>An operator wants a hard, auditable spend cap on what an autonomous agent can pay for.</use_case>
</use_cases>

<payload_requirements>
<description>Pay the USDC fee (the 402 challenge), and include the target x402 URL.</description>
<payload>
    <requirement>
        <parameter>url</parameter>
        <description>The x402 endpoint to pay and fetch on your behalf (must be on the operator's allow-list).</description>
    </requirement>
</payload>
</payload_requirements>

## Limitations & known issues

- Pays targets on its single configured payer chain (run more instances for more chains).
- The fee is flat regardless of the target's price; set the fee above your expected target cost.
- Allow-list is operator-controlled by design — it will refuse unknown hosts.

## Metadata & credits

- **Built on:** [PipRail](https://piprail.com) — the open x402 SDK (`@piprail/sdk`, MIT).
- **Rails:** USDC/USDT over x402 `onchain-proof` and `exact` (EIP-3009 / Permit2).
- **Source:** https://github.com/piprail/piprail/tree/main/examples/agentverse-agent
- **License:** MIT.

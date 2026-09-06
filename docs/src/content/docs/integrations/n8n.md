---
title: n8n
description: 'Pay x402 URLs from any n8n workflow with a budget-bound PipRail wallet. A native n8n community node wrapping @piprail/sdk, self-custody, EVM chains.'
sidebar:
  order: 4
---

[n8n](https://n8n.io) workflows can **pay for an [x402](https://x402.org)-gated API and keep going** with
PipRail, the missing "pay two cents and continue" step for automations and AI-agent workflows. It's a
**community node** that settles straight from your own wallet, [budget-bound](/spend-controls/payment-policy/)
and verified on your own RPC: no facilitator, no fee.

## How it works

Like the [elizaOS](/integrations/elizaos/) plugin (and unlike [OpenClaw](/integrations/openclaw/) /
[Hermes](/integrations/hermes/), which wire the [`@piprail/mcp`](/mcp/overview/) server), n8n gets a
**native node**,
[`@piprail/n8n-nodes-piprail`](https://github.com/piprail/piprail/tree/main/integrations/n8n/piprail), that
wraps the published [`@piprail/sdk`](https://www.npmjs.com/package/@piprail/sdk) directly. The SDK is bundled
into the package, so it installs with **zero runtime dependencies**, and the wallet key is read **only** from
the encrypted n8n credential, never from the environment or filesystem.

The node sets `usableAsTool: true`, so an **n8n AI Agent node can call it directly** as a budget-bound
payment tool.

:::note[EVM chains (v1)]
The SDK reaches [every supported chain](/chains/overview/), but its non-EVM drivers load extra libraries on
demand, which a self-contained, zero-dependency n8n node can't bundle. v1 ships the EVM path (`viem`) inlined;
name any EVM chain in the credential.
:::

## Install

In your self-hosted n8n: **Settings → Community Nodes → Install**, then enter:

```
@piprail/n8n-nodes-piprail
```

## Credential

Add a **PipRail API** credential:

| Field | Required | Default | Purpose |
| --- | --- | --- | --- |
| **Private Key** | **yes** | none | Hex key (`0x…`) of the wallet payments are sent from. Stored as an encrypted n8n credential; read only from there. |
| **Chain** | no | `base` | EVM chain to pay on, e.g. `base`, `ethereum`, `arbitrum`, `optimism`, `polygon`, `bnb`, `avalanche`. |
| **RPC URL** | no | none | Optional custom RPC. Leave blank to use the SDK default for the chain. |

:::danger[Pay URL spends autonomously]
The **Pay URL** operation moves money without a per-payment confirmation, bounded only by the spend caps.
Keep the caps conservative, fund the wallet with only what the workflow may spend, and treat the key as hot.
:::

## Operations

One **PipRail** node, four operations:

| Operation | What it does | Moves money? |
| --- | --- | --- |
| **Pay URL** | Fetch a URL; if it returns HTTP 402, pay within the spend caps and return the unlocked response | **yes** |
| **Plan Payment** | Read-only: can the wallet afford it, and on which rail | no |
| **Quote** | Read-only: the price of a gated URL | no |
| **Estimate Cost** | Read-only: price plus a gas estimate in the native coin | no |

**Pay URL** returns `{ status, ok, paid, transaction, receipt, body }`. `paid`/`transaction` reflect a real
on-chain settle (even when the merchant emits no receipt), and `receipt` is the verifiable receipt when one is
provided. It pays with `schemes: ['onchain-proof', 'exact']`, so it also settles standard x402 servers.

## Spend caps

On the **Pay URL** operation, open **Spend Caps**:

| Cap | Maps to | Purpose |
| --- | --- | --- |
| **Max Per Payment** | `policy.maxAmount` | Ceiling for any single payment |
| **Max Total** | `policy.maxTotal` | Lifetime ceiling for the whole execution. It **accumulates across every input item** (one shared ledger), so feeding N items can't spend N × the cap |

Both are checked **before any on-chain send**, so the workflow cannot overspend. Full policy surface:
[Payment policy](/spend-controls/payment-policy/).

## Verify

Point the node at the live demo (0.01 USDC on Base):

1. **Quote** `https://piprail.com/x402/demo` → the price, no funds moved.
2. **Pay URL** → `status 200`, `paid: true`, and the on-chain `transaction`.
3. **Cap holds.** Set **Max Total** below the price and confirm the node is declined, no funds moved.

The runnable node lives at
[`integrations/n8n/piprail/`](https://github.com/piprail/piprail/tree/main/integrations/n8n/piprail):
`npm run build`, `npm run typecheck`, `npm run smoke`, `npm run lint` (passes n8n's own `n8n-node lint`). It's
proven on Base mainnet by driving the node's own `execute()`: a real on-chain settle, with the `maxTotal` cap
enforced across multiple items.

## See also

- [Agent toolkit: `paymentTools`](/agent-toolkit/payment-tools/) · [MCP overview](/mcp/overview/)
- [Spend controls](/spend-controls/payment-policy/) · [Chains](/chains/overview/)

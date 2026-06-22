# @piprail/n8n-nodes-piprail

An [n8n](https://n8n.io) community node that lets a workflow **pay an [x402](https://x402.org) (HTTP 402) URL** — self-custody, across EVM chains, with no facilitator and no fee. It's the missing "pay for this API and keep going" step for n8n automations and AI Agent workflows.

Built on [`@piprail/sdk`](https://www.npmjs.com/package/@piprail/sdk). Payments settle straight from your own wallet, verified on-chain — there is no middleman holding funds and no protocol cut.

## What it does

One **PipRail** node with four operations:

| Operation | What it does | Moves money? |
|---|---|---|
| **Pay URL** | Fetch a URL; if it returns HTTP 402, pay within your spend caps and return the unlocked response | yes |
| **Plan Payment** | Check whether the wallet can afford it, and on the cheapest rail | no (read-only) |
| **Quote** | The price of a gated URL | no (read-only) |
| **Estimate Cost** | Price plus a gas estimate in the chain's native coin | no (read-only) |

The node is marked `usableAsTool`, so an **AI Agent node can call it directly** — give the agent a budget-bound wallet it can use to pay for APIs mid-run.

## Install

In your self-hosted n8n: **Settings → Community Nodes → Install**, then enter:

```
@piprail/n8n-nodes-piprail
```

## Setup

1. Add a **PipRail API** credential:
   - **Private Key** — the hex key (`0x…`) of the wallet payments are sent from. Stored as an encrypted n8n credential; the node **never** reads a key from the environment or the filesystem.
   - **Chain** — the EVM chain to pay on (e.g. `base`, `ethereum`, `arbitrum`, `polygon`, `bnb`). Defaults to `base`.
   - **RPC URL** — optional; leave blank to use the SDK default.
2. Drop a **PipRail** node into a workflow, choose an operation, and set the **URL**.
3. For **Pay URL**, optionally set **Spend Caps** (max per payment, max total) — hard limits enforced *before* any on-chain send, so the workflow can't overspend.

Try it against the live demo endpoint: [`https://piprail.com/x402/demo`](https://piprail.com/x402/demo) (pays $0.01 USDC on Base).

## Scope (v1)

**EVM chains only.** The PipRail SDK reaches 29 chains, but its non-EVM drivers load extra libraries on demand — which a self-contained, zero-runtime-dependency n8n node can't bundle. v1 therefore ships the EVM path (`viem`) bundled in. Name any EVM chain in the credential; non-EVM chains are out of scope for this node.

The node carries **no runtime dependencies** — the SDK is bundled into the package, nothing is fetched at install or run time, and the wallet key is read only from the n8n credential.

## Links

- **Docs:** https://docs.piprail.com
- **SDK:** https://www.npmjs.com/package/@piprail/sdk
- **Site:** https://piprail.com
- **Source:** https://github.com/piprail/piprail/tree/main/integrations/n8n/piprail

MIT © PipRail

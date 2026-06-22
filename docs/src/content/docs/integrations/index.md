---
title: Integrations
description: First-party PipRail integrations with agent frameworks and skill marketplaces.
sidebar:
  label: Overview
  order: 0
---

PipRail works today as a standalone SDK — gate a server route with [`requirePayment`](/accepting-payments/require-payment-and-gate/), pay as a client with [`PipRailClient`](/making-payments/piprail-client/), or hand an agent a budget-bound wallet via the [MCP server](/mcp/overview/), across [every supported chain](/chains/overview/).

These pages cover **first-party integrations** that drop PipRail into the frameworks where agents already live — without writing payment code.

## Available

| Integration | What it gives you |
| --- | --- |
| [OpenClaw](/integrations/openclaw/) | A ClawHub skill that hands an OpenClaw agent the full set of PipRail tools (budget-bound), via [`@piprail/mcp`](/mcp/overview/). |
| [Hermes](/integrations/hermes/) | A Hermes MCP catalog entry (and Skills Hub skill) — add one `mcp_servers` block and the agent gets the full set of PipRail tools, budget-bound. |
| [elizaOS](/integrations/elizaos/) | A **native** elizaOS plugin (`@piprail/elizaos-plugin`) that wraps [`@piprail/sdk`](/agent-toolkit/payment-tools/)'s `paymentTools` as six budget-bound agent actions (pay / quote / plan / discover / budget / guide) — add `piprailPlugin` to your character; no MCP server needed. |
| [n8n](/integrations/n8n/) | A **native** n8n community node (`@piprail/n8n-nodes-piprail`) — pay / plan / quote / estimate an x402 URL from any workflow, callable by n8n AI Agent nodes and budget-bound. Install via Settings → Community Nodes. |

More framework integrations are on the way. Any MCP client can use PipRail today via the [MCP server](/mcp/overview/) — see [Client setup](/mcp/client-setup/).

---
title: Chains
description: Run the MCP server on any PipRail chain — EVM works out of the box, non-EVM families lazy-load a peer, and several chains means one namespaced server each.
sidebar:
  order: 7
---

## Introduction

The MCP server pays on whatever chain you name in `PIPRAIL_CHAIN`. EVM presets run with
nothing extra; non-EVM families need their SDK peer library available alongside the server.
Each instance is **one wallet on one chain** — to give an agent several rails, you run the
server once per chain.

The chain you pick also decides the wallet format you supply in `PIPRAIL_PRIVATE_KEY` (see
[Configuration](/mcp/configuration/)) and the default token (see below).

## EVM runs out of the box

`npx -y @piprail/mcp` ships with `viem`, so `base`, `ethereum`, `arbitrum`, `polygon`, `bnb`,
and every other EVM preset just run — no extra install.

```json
{
  "mcpServers": {
    "piprail": {
      "command": "npx", "args": ["-y", "@piprail/mcp"],
      "env": { "PIPRAIL_PRIVATE_KEY": "${env:PIPRAIL_PRIVATE_KEY}", "PIPRAIL_CHAIN": "base" }
    }
  }
}
```

`PIPRAIL_CHAIN` defaults to `base`, so omitting it gives you Base. A mistyped or unsupported
chain fails loudly at startup rather than silently doing nothing.

## Non-EVM families lazy-load a peer

The SDK keeps the non-EVM libraries as optional lazy peers so EVM installs stay lean. Naming a
non-EVM chain (`solana`, `ton`, `tron`, `near`, `sui`, `aptos`, `algorand`, `stellar`, `xrpl`)
means you must make that family's peer available alongside the server. The clean way is a single
`npx -p` invocation that adds the peers to the same throwaway environment as the server:

```bash
# Solana
npx -y -p @piprail/mcp -p @solana/web3.js -p @solana/spl-token -p bs58 piprail-mcp
```

The binary is `piprail-mcp` and each `-p` adds one package to the run. The per-family peers are
listed in [`@piprail/sdk`'s `peerDependencies`](https://www.npmjs.com/package/@piprail/sdk) —
pass the same set after the `-p` flags for whichever family you're running.

## The default token is chain-aware

`PIPRAIL_TOKENS` defaults to the canonical stablecoin that actually **exists** on the chain:
**USDC** everywhere, but **USDT** on **Tron** and **TON** (native USDC doesn't exist there, so a
USDC-only policy would silently block every payment). Override it anytime:

```jsonc
"PIPRAIL_TOKENS": "USDC,native"   // also allow the chain's own coin
```

The allowlist takes token **symbols** (`USDC`, `USDT`, `EURC`, …) plus the chain-agnostic alias
**`native`**, which allows the chain's own coin (ETH on Base, TRX on Tron, XLM on Stellar, …)
without naming the ticker. See [Concepts: chains and tokens](/concepts/chains-and-tokens/) for
the full coverage.

## Per-chain caveats

The server prints a `⚠ notes:` block on startup where these apply. API keys are the recurring
one: the SDK has **no separate API-key field** — fold any key into the `PIPRAIL_RPC_URL`.

| Chain | What to watch |
| --- | --- |
| **TON** | A keyed RPC is effectively required — the keyless public endpoint is rate-limited (~1 req/s) and stalls verification. Use `PIPRAIL_RPC_URL=https://toncenter.com/api/v2/jsonRPC?api_key=YOUR_KEY`. Pays **USDT**; key is a 24-word mnemonic. |
| **Tron** | The default public RPC (TronGrid) is rate-limited; point `PIPRAIL_RPC_URL` at a higher-limit endpoint (URL-embedded key, no header field). Gas is real **TRX**, so the wallet needs TRX as well as USDT. Pays **USDT**; key is a `0x…` 32-byte hex private key. |
| **NEAR** | Set `PIPRAIL_NEAR_ACCOUNT_ID` (your `merchant.near`) alongside the `ed25519:…` key — startup fails without it. |
| **Stellar / XRPL / Algorand** | Receiving needs a one-time trustline/opt-in on the *recipient* side. |

For the recipient-readiness caveats, `piprail_plan_payment` reports `recipientReady` so the agent
knows before it pays — see [planPayment()](/making-payments/plan-payment/). The full per-chain
list lives in the SDK's
[CHAINS.md](https://github.com/piprail/piprail/blob/main/sdk/CHAINS.md), and each family has its
own page under [Chains](/chains/overview/).

## Paying on multiple chains at once

Each server instance is one wallet on one chain. To give an agent several rails, register the
server once per chain — each MCP entry is namespaced, so the agent gets all of them:

```json
{
  "mcpServers": {
    "piprail-base": {
      "command": "npx", "args": ["-y", "@piprail/mcp"],
      "env": { "PIPRAIL_PRIVATE_KEY": "${env:EVM_KEY}", "PIPRAIL_CHAIN": "base" }
    },
    "piprail-solana": {
      "command": "npx", "args": ["-y", "@piprail/mcp"],
      "env": { "PIPRAIL_PRIVATE_KEY": "${env:SOLANA_SECRET}", "PIPRAIL_CHAIN": "solana" }
    },
    "piprail-tron": {
      "command": "npx", "args": ["-y", "@piprail/mcp"],
      "env": {
        "PIPRAIL_PRIVATE_KEY": "${env:TRON_KEY}",
        "PIPRAIL_CHAIN": "tron",
        "PIPRAIL_RPC_URL": "https://api.trongrid.io"
      }
    }
  }
}
```

:::caution
Each `PIPRAIL_PRIVATE_KEY` above must be the right format for **its** chain — a `0x…` hex key for
Base/Tron, a base58 secret for Solana (see the [wallet key formats](/mcp/configuration/)). Never
paste a raw key into the config file: keep it in an env var and interpolate with `${env:…}` where
your client supports it, or treat the config file as a secret (Claude Desktop has no interpolation).
:::

:::note
On Tron and TON, `PIPRAIL_TOKENS` already defaults to `USDT` — you don't need to set it. Swap the
TronGrid URL for your own higher-limit endpoint in production, and keep TRX in the wallet for gas.
:::

:::tip
A custom EVM chain that isn't a preset isn't reachable from `PIPRAIL_CHAIN` — the server only
accepts named presets and non-EVM families. For one of those, drive the SDK directly with a viem
`Chain`; see [Use it as a library](/mcp/use-as-a-library/).
:::

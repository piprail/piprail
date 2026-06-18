---
title: Installation
description: Install @piprail/sdk and its viem peer dependency, plus the optional per-family libraries for non-EVM chains.
sidebar:
  order: 2
---

## Introduction

PipRail is pure TypeScript with a single required peer dependency — `viem` — and a set of
**optional** peers, one per non-EVM family, that are lazy-loaded only when you actually name
that chain. A pure-EVM install never downloads them.

## Install the SDK

```bash
npm install @piprail/sdk viem
```

That's everything you need for **every EVM chain** — Base, BNB, Polygon, Arbitrum, Optimism, and
the rest of the built-in presets, plus any other EVM chain by `{ id, rpcUrl }`.

:::note
`viem` is a **peer dependency**, not bundled. This keeps the SDK light and lets you share one
`viem` version across your app.
:::

## Non-EVM families — add a peer when you use one

Each non-EVM family lazy-imports its own library on first use, so you only install what you
actually pay on. Add the peer alongside `@piprail/sdk`:

| Chain you name | Install alongside `@piprail/sdk` |
| --- | --- |
| `solana` | `@solana/web3.js @solana/spl-token bs58` |
| `ton` | `@ton/ton @ton/core @ton/crypto` |
| `tron` | `tronweb` |
| `near` | `near-api-js` |
| `sui` | `@mysten/sui` |
| `aptos` | `@aptos-labs/ts-sdk` |
| `algorand` | `algosdk` |
| `stellar` | `@stellar/stellar-sdk` |
| `xrpl` | `xrpl` |

```bash
# Example: paying on Solana
npm install @piprail/sdk @solana/web3.js @solana/spl-token bs58
```

If you name a family whose peer isn't installed, PipRail throws a
[`MissingDriverError`](/errors/error-model/) whose message tells you the exact `npm install` to
run — it never fails silently.

## Requirements

- **Node.js 20+** (or any modern runtime — Bun, Deno, Cloudflare Workers, the browser).
- **An RPC endpoint** for each chain you use. The built-in presets ship sensible public
  defaults; pass your own `rpcUrl` for production. Fold any API key directly into the RPC URL.

## In the browser — no build, no npm

The SDK runs unbundled in the browser via an ESM CDN, so you can pay a 402 from a plain HTML
page. In the browser you **never paste a private key** — you hand the SDK an injected
`walletClient` (MetaMask, Rabbit, any EIP-1193 provider) so signing stays in the wallet:

```html
<script type="module">
  import { PipRailClient } from 'https://esm.sh/@piprail/sdk'
  import { createWalletClient, custom } from 'https://esm.sh/viem'
  import { base } from 'https://esm.sh/viem/chains'

  // Build a viem wallet client from the injected EIP-1193 provider — keys stay in the wallet.
  // Attach the connected account + chain: the SDK rejects an account-less client, and the
  // JSON-RPC account routes every signature back through the wallet.
  const [address] = await window.ethereum.request({ method: 'eth_requestAccounts' })
  const walletClient = createWalletClient({ account: address, chain: base, transport: custom(window.ethereum) })

  const client = new PipRailClient({ chain: 'base', wallet: { walletClient } })

  const res = await client.fetch('https://api.example.com/report') // pays the 402 for you
  const data = await res.json()
</script>
```

:::caution
**EVM only, out of the box.** A bare CDN import covers every EVM chain in the browser. The
non-EVM families need their peer libraries resolvable too: `solana`, `sui`, and `near` work
with an [import map](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/script/type/importmap)
that pins each peer's CDN URL, while `ton`, `tron`, `xrpl`, and `stellar` rely on libraries
that assume Node and are **server-side only**. Pay on those from a backend.
:::

:::danger
The raw-key wallet shape `{ key }` is for **server-side use only** — never
ship a private key to the browser. In a page, always use an injected `{ walletClient }` as
shown above so the key never leaves the user's wallet.
:::

Next: the [Quickstart](/getting-started/quickstart/) takes a payment and pays it, end-to-end.

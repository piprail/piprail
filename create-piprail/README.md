# create-piprail

**Scaffold a self-hosted x402 merchant in one command.** Accept stablecoin payments — from humans
**and** AI agents — straight to your own wallet. Paste a **public address**; no private key, no
account, no backend, no fee.

```sh
npm create piprail@latest
```

It's the seller's mirror of the buyer's zero-code on-ramp (`npx -y @piprail/mcp`): one command and you
have a runnable, **mainnet-by-default**, agent-discoverable payment endpoint — no code to write, no
hosting to figure out.

## What you get

An interactive wizard (or flags) asks **what you're selling**, **which chain + token**, and **your
public wallet address**, then generates a complete app:

```
my-shop/
├── package.json          # depends only on @piprail/sdk (+ express for the node host)
├── src/gate.mjs          # the ONE bit of PipRail code — createPaywall / createTipJar, config baked in
├── src/verify.mjs        # `npm run verify` → gate.selfTest(), a no-sign config check
├── src/server.mjs        # node/express  ·  OR  src/worker.mjs + wrangler.toml (Cloudflare)
└── README.md
```

It also serves `/.well-known/x402` so AI agents can discover and price your endpoint.

## Non-interactive (CI / scripts)

```sh
npm create piprail -- my-shop \
  --sell api \           # api (paywall) | tip (tip jar)
  --chain base \         # any mainnet chain @piprail/sdk supports
  --token USDC \
  --pay-to 0xYourPublicAddress \
  --amount 0.05 \        # price (api) or --min (tip)
  --host cloudflare \    # node | cloudflare
  --yes
```

## Why it's safe to paste your address

Receiving an x402 payment needs only your **public** wallet address. PipRail verifies each payment
locally against your own RPC — there's no key in the project, no custody, and no PipRail account. The
generated `src/gate.mjs` is the whole integration.

MIT · [piprail.com](https://piprail.com) · [docs.piprail.com](https://docs.piprail.com)

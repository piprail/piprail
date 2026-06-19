# Browser / CDN — x402 in a `<script>` tag (no build, no npm)

A single self-contained HTML page that loads `@piprail/sdk` straight from a CDN and runs it **in the browser** — no bundler, no `npm install`, no backend. [`index.html`](./index.html) is the whole thing.

## Run it

Open the file — that's it:

```bash
open index.html            # macOS
# or serve it anywhere static:
npx serve .                # then visit the printed URL
```

It pulls the SDK from jsDelivr at runtime, so the only requirement is a network connection. Drop the same file on Netlify, GitHub Pages, S3, a Notion embed — anywhere that serves HTML.

## What it demonstrates (all live, on the page)

- **The SDK loads from a CDN** (`https://cdn.jsdelivr.net/npm/@piprail/sdk@2/+esm`) and runs in the browser — the status line shows it resolve.
- **The merchant side builds a real `402` challenge from your wallet address alone** — no private key. Pick a chain/token/amount and watch PipRail generate the actual x402 envelope in-browser.
- **The payer side quotes it** — `PipRailClient.quote()` parses the challenge and prices the payment (amount, chain, token, recipient, "within budget"), the same code that runs against any live gated URL.
- **A real on-chain payment** was made *from a browser* with this exact flow during testing — the page links the [proof tx](https://bscscan.com/tx/0x3ca933a1c2eba019c580e70ab0311c6995dba96f7c10fb2af1f89abb78053bce).

## The two CDNs

Any npm-mirroring CDN works — pick one:

```js
import { PipRailClient } from 'https://esm.sh/@piprail/sdk'              // esm.sh
import { PipRailClient } from 'https://cdn.jsdelivr.net/npm/@piprail/sdk@2/+esm'  // jsDelivr
```

Both resolve `viem` (and any chain lib the SDK lazy-imports) automatically — you don't add a second `<script>` for the chain library; the SDK pulls it from the same CDN on first use, only for the chain you actually name.

## ⚠ Keys in the browser

The interactive demo never signs — quoting only reads a `402`. To actually **pay** from a browser, sign with the **visitor's injected wallet**, never a raw key in your page (page source is public):

```js
import { createWalletClient, custom } from 'https://esm.sh/viem'
const walletClient = createWalletClient({ transport: custom(window.ethereum) })
const client = new PipRailClient({ chain: 'base', wallet: { walletClient } })
await client.fetch('https://api.example.com/paid')   // 402 → MetaMask signs → 200
```

Raw `{ key }` wallets belong only in a **server's** environment. The merchant gate (`requirePayment` / `createPaymentGate`) needs only an address, so it's safe anywhere.

See the [docs](https://docs.piprail.com/getting-started/installation/) for the full browser story, and [`../../CONCEPTS.md`](../../CONCEPTS.md) for the 402 loop.

# x402-parity sandbox — live proof the **published** SDK + MCP work

A self-contained harness that exercises the four **x402-parity** features of PipRail against the
**real npm packages** — not the workspace build. It installs `@piprail/sdk` and `@piprail/mcp`
from the registry, so a green run is a guarantee about *what `npm i @piprail/sdk` actually ships*.

> The companion [`../sdk-sandbox`](../sdk-sandbox) and [`../mcp-sandbox`](../mcp-sandbox) cover the
> broad surface; **this** sandbox is laser-focused on the newest capabilities and runs them live on
> Base mainnet.

## What it proves

| Suite | Feature | Why it matters |
|---|---|---|
| `01-verifiable-receipts` | **Verifiable receipts** — chain-grounded (R1) + EIP-712 attestation (R2) | A payment now produces a portable, self-contained proof anyone can re-verify with no wallet and no trust in the sender. Forged fields are caught; a privacy-suppressed tx still verifies via R2. |
| `02-upto-metered` | The **`upto` metered rail** — pay-for-what-you-use, buyer-gasless | Authorize a MAX once; the merchant settles only the actual amount (≤ MAX) and pays the gas. Over-meter is refused with nothing broadcast; a zero charge moves no money. |
| `03-policy-merchant-proof` | The **merchant-proof spend leash (POL-1)** | The buyer's budget debits the authorized **MAX**, never the merchant's self-reported actual — so an under-reporting merchant can't loosen the caps. Proven on-chain: 2 settle, the 3rd is blocked. |
| `04-a2a-google` | The **A2A (Google Agent2Agent) transport** | x402's third official transport. The same envelopes ride Google A2A `Task`/`Message` metadata instead of HTTP headers — every chain for free. A real Base payment settles *through* the A2A seller adapter. |
| `05-mcp-verify-receipt` | The MCP's **8th tool, `piprail_verify_receipt`** | Any MCP client (Claude Desktop, Cursor, …) can re-verify a receipt on-chain — read-only, wallet-free. A real receipt verifies; a forged payer is caught. |

## Run it

```bash
npm install         # pulls the PUBLISHED @piprail/sdk + @piprail/mcp
npm test            # all five suites

# or one at a time
npm run receipts
npm run upto
npm run policy
npm run a2a
npm run mcp
```

## Static vs live

Every suite has a **static** section that runs without a funded wallet, without secrets, and
**spends no money** — asserting the published API surface and the wire shapes. (A few read public
RPC read-only — e.g. the `upto` 402 reads the token's EIP-712 domain — but nothing is ever signed
or broadcast.) The **live** sections settle **tiny** amounts of real Base-mainnet USDC and only run
when the gitignored test wallet `../../../.secrets/wallets/evm-wallet.json` is present; otherwise
they self-skip and the suite still passes on its static assertions.

- `BASE_RPC` — override the Base RPC endpoint (default: a public node).
- `PIPRAIL_WALLET` — override the wallet path.

No secret is ever printed, and the wallet file is never committed.

# x402-parity sandbox — live proof the **published** SDK + MCP work

A self-contained harness that exercises PipRail's x402-parity + 2.14.x features **and adversarially
tries to break them**, against the **real npm packages** — not the workspace build. It installs
`@piprail/sdk@2.14.1` + `@piprail/mcp@0.9.0` from the registry (a guard in `lib/env.mjs` throws if
the SDK ever resolves to the workspace), so a green run is a guarantee about *what `npm i
@piprail/sdk` actually ships*. **15 suites, ~1,000+ assertions** — see [`FINDINGS.md`](./FINDINGS.md)
for what the break-it pass turned up and [`HARNESS.md`](./HARNESS.md) for how to add a suite.

> The companion [`../sdk-sandbox`](../sdk-sandbox) and [`../mcp-sandbox`](../mcp-sandbox) cover the
> broad surface; **this** sandbox is laser-focused on the newest capabilities + a hostile-input
> battery, and runs the happy paths live on Base mainnet.

## What it proves

**x402-parity features (01–05):**

| Suite | Feature | Why it matters |
|---|---|---|
| `01-verifiable-receipts` | **Verifiable receipts** — chain-grounded (R1) + EIP-712 attestation (R2) | A payment now produces a portable, self-contained proof anyone can re-verify with no wallet and no trust in the sender. Forged fields are caught; a privacy-suppressed tx still verifies via R2. |
| `02-upto-metered` | The **`upto` metered rail** — pay-for-what-you-use, buyer-gasless | Authorize a MAX once; the merchant settles only the actual amount (≤ MAX) and pays the gas. Over-meter is refused with nothing broadcast; a zero charge moves no money. |
| `03-policy-merchant-proof` | The **merchant-proof spend leash (POL-1)** | The buyer's budget debits the authorized **MAX**, never the merchant's self-reported actual — so an under-reporting merchant can't loosen the caps. Proven on-chain: 2 settle, the 3rd is blocked. |
| `04-a2a-google` | The **A2A (Google Agent2Agent) transport** | x402's third official transport. The same envelopes ride Google A2A `Task`/`Message` metadata instead of HTTP headers — every chain for free. A real Base payment settles *through* the A2A seller adapter. |
| `05-mcp-verify-receipt` | The MCP's **8th tool, `piprail_verify_receipt`** | Any MCP client (Claude Desktop, Cursor, …) can re-verify a receipt on-chain — read-only, wallet-free. A real receipt verifies; a forged payer is caught. |

**2.14.0 features + adversarial break-it battery (06–15):**

| Suite | Area | What it hammers |
|---|---|---|
| `06-mcp-transport` | **x402-over-MCP seller transport** (`createMcpPaymentTool`) — the 3rd transport | byte-equal challenge view; 34-input never-throw reader sweep; **forged/downgraded `accepted` + attacker `payTo` never settles or leaks**; live settle + replay on Base. |
| `07-payment-identifier` | **`payment-identifier` idempotency** (new) | full id-validation matrix (length/charset/type/proto-pollution); gate advertises iff opt-in; **live: a fresh tx reusing a seen id is rejected by the pid dedupe** (distinct from tx-replay). |
| `08-wellknown-discovery` | `.well-known/x402.json` manifest + discovery docs | manifest shape + determinism + forward-compat; bazaar/OpenApi/DNS; hostile origins/resources. |
| `09-api-surface` | published-artifact surface + package hygiene | all 146 exports import (ESM + CJS + `/node`); error-class `.code`s; the `./package.json` export gap. |
| `10-wire-codec-fuzz` | every `parse*`/`decode*` codec | empty/huge/non-JSON/scientific-notation/**prototype-pollution** inputs → never throw, never pollute. |
| `11-typed-errors-reads` | typed errors + never-throw reads | right typed error per bad input; `estimateCost`/`planPayment`/`canAfford` graceful on a dead RPC. |
| `12-multichain-agent` | multi-chain planning + agent toolkit | `planAcross`/`pickAccept`/`normalizeNetwork`; **characterizes the F-A1/F-A2 never-throw bugs**. |
| `13-policy-ledger-spend` | spend policy + ledger (POL-1) | cap matrix incl. zero/negative/`MAX_SAFE_INTEGER`; `fileSpendStore` round-trip; corrupt-store safety. |
| `14-gate-challenge-families` | gate challenges across all 12 families | v2-conformant envelopes + exact BigInt base-unit math; adversarial amounts (incl. the `1e3` footgun). |
| `15-estimate-cost-gas` | gas estimates across chains | native-coin-distinct-from-token; finite/safe; gasless → fee 0; foreign-only divergence (F-A3). |

## Run it

```bash
npm install         # pulls the PUBLISHED @piprail/sdk@2.14.1 + @piprail/mcp@0.9.0
npm test            # all 15 suites (offline); live legs need the wallet + PIPRAIL_LIVE=1

PIPRAIL_LIVE=1 node suites/07-payment-identifier.mjs   # one suite, live on Base mainnet
```

Live (on-chain) legs in the **new** suites (06–15) are gated behind **both** the `.secrets` wallet
**and** `PIPRAIL_LIVE=1`, so a default run is money-free and free of EOA-nonce races. See
[`HARNESS.md`](./HARNESS.md).

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

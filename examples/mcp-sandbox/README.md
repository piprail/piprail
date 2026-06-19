# `mcp-sandbox` — adversarial proof that `@piprail/mcp` + `@piprail/sdk` work, and that the spend caps can't be broken

**This folder is a runnable test harness, not a payment app.** Every other folder
in `examples/` shows you *how to use* PipRail. This one **proves it works** — it
spawns the real, published [`@piprail/mcp`](../../mcp) server as a subprocess,
talks to it over the actual MCP stdio protocol exactly like Claude Desktop or
Cursor would, and then attacks it: as a greedy AI **and** as a lying merchant,
trying every trick to overspend. It can't. **169 checks, all green.**

```bash
# From the repo root (tests your LOCAL build):
npm run build:sdk && npm run build:mcp
cd examples/mcp-sandbox
node run-all.mjs
```

```text
▸ 01 · Handshake, server identity & tool schemas (real subprocess + stdio)
▸ 02 · tool surface — quote / plan / pay full I/O
▸ 03 · ADVERSARIAL — hostile merchant vs the real MCP
▸ 04 · config / SDK-consumption surface (every chain, every wallet format)
▸ 05 · LIVE caps under real on-chain settlement (Anvil fork of Base)
── summary ──
ALL 169 CHECKS PASSED
```

---

## Why this exists (read this if you're an AI agent or an auditor)

PipRail's entire safety promise is one sentence: **the model cannot overspend,
even if it tries.** If you give an autonomous agent a wallet, the *only* thing
standing between it and your funds is the spend policy
(`maxAmount` per call, `maxTotal` lifetime, `tokens`, `hosts`). So the policy has
to hold under adversarial pressure — a confused or malicious agent, *and* a
malicious merchant feeding it lies.

This harness is the evidence. It doesn't test mocks; it drives the **same binary
you run with `npx -y @piprail/mcp`** and proves, end to end and on-chain, that:

- the per-call cap can't be exceeded — even by a merchant that **lies about the
  amount** (fake decimals, fake display string, spoofed symbol);
- the lifetime cap halts spending across **many** small calls — you can't drain a
  wallet by salami-slicing;
- every refusal happens **before any on-chain send** — declined calls move
  **zero** funds (verified by reading balances on a forked chain);
- and the whole MCP↔SDK wiring (config → policy → client → tools) is correct for
  **every chain and wallet format** the package supports.

## Is it safe to run? (yes — no real money, no real keys)

- All wallet keys are **throwaway constants** generated in-process (e.g.
  `0x1111…`). None hold funds.
- The **offline suites (01–04)** never broadcast a transaction. They only *quote*
  / *plan* gated URLs (read-only) or *pay* URLs the policy **declines** (refused
  locally). They also point the client at a dead RPC (`127.0.0.1:1`) so they run
  fully **offline**.
- The **live suite (05)** spins up a local **Anvil fork of Base** and deals
  itself *fake* USDC by writing contract storage. Every "real" payment settles on
  that disposable fork, which is killed when the suite finishes. **Zero mainnet
  funds are ever touched.**

## How to run

### Inside this monorepo (tests your local changes)
```bash
npm run build:sdk && npm run build:mcp   # from the repo root — the harness drives the built dist
cd examples/mcp-sandbox
node run-all.mjs                          # all five suites
```
No `npm install` needed in this folder — it resolves `@piprail/mcp`,
`@piprail/sdk`, `@modelcontextprotocol/sdk`, `express`, and `viem` from the repo
root's `node_modules`.

### Standalone (tests the PUBLISHED packages)
```bash
cd examples/mcp-sandbox
npm install        # pulls @piprail/mcp + @piprail/sdk from npm
node run-all.mjs
```
> This harness lives in the monorepo and tracks the SDK/MCP **in this repo**, so a
> check or two may assert behavior shipping in the next release (e.g. the `native`
> token alias). For a guaranteed-green run, use the in-repo flow above; standalone
> needs published versions that include those behaviors.

### Individual suites
```bash
npm run protocol   # 01 — handshake, tool schemas, config errors, banner
npm run tools      # 02 — full quote/plan/pay I/O, POST+body, multi-rail, native
npm run attacks    # 03 — hostile merchant + policy-core hammering
npm run config     # 04 — every chain/family/wallet format, banner, versions
npm run live       # 05 — real on-chain caps (needs Foundry + a Base RPC)
npm run merchant   # just stand up the honest x402 merchant on :8402
```

### The live suite's one external dependency
Suite 05 needs Foundry's [`anvil`](https://book.getfoundry.sh/) on your `PATH`
and a Base mainnet RPC to fork. It defaults to `https://mainnet.base.org`;
override with `BASE_FORK_RPC=<your-rpc>`. **If `anvil` or the RPC is unavailable
it skips cleanly — never a failure.** (Suites 01–04 already prove the policy
logic without a chain.)

---

## What each suite proves

### 01 · Protocol & transport (real subprocess over stdio)
The handshake succeeds; the server reports `name: "piprail"` and a version that
matches the package; it advertises **exactly** the 5 tools
(`piprail_quote_payment`, `piprail_plan_payment`, `piprail_pay_request`) with
correct JSON Schemas; an unknown tool returns an `isError` result instead of
crashing; every bad config exits non-zero with a helpful message; and the boot
banner is informative + **secret-free** with a **clean stdout** (a stray stdout
byte would corrupt MCP framing — proven by a separate boot snapshot).

### 02 · Tool surface — everything the 5 tools expose from the SDK
Full `quote` shape (asset, network, base-unit amount, true decimals/symbol,
`payTo`, description, `recognized`, `symbolMismatch`, `withinPolicy`); the native
coin is recognized and priced; full `plan` shape with typed `blockers`/`warnings`
and graceful degradation on a dead RPC (state `unknown`, never a false
"unaffordable"); `pay` over GET **and** POST-with-JSON-body; the asymmetry where
an off-chain-only 402 makes `quote` error but `plan` degrade gracefully;
multi-rail selection (the client only ever considers its own chain's rail); a
malformed challenge becomes a typed error, not a crash; and a bad wallet key
surfaces as a tool error (the SDK's wallet validation, reached through MCP).

### 03 · ADVERSARIAL — you cannot trick the cap
A **hostile merchant** that lies, driven through the real MCP:

| Attack the merchant tries | Why it fails |
|---|---|
| Claim `decimals:9` / display `"0.005"` for a real **5.0 USDC** charge | The cap re-derives the amount at the token's **TRUE** decimals → refused |
| Lie about the human-readable amount | The display string is ignored; the real amount is used |
| Charge exactly the `0.10` cap / one base unit over | At-cap is **allowed** (`>`, not `>=`); +1 base unit is **refused** |
| Offer an unpriceable asset wearing a `"USDC"` badge | `recognized:false` → refused (won't pay on trust) |
| Spoof the symbol (USDC→DAI) on real USDC | The **true** symbol governs the allowlist; the mismatch is flagged |
| Bury an over-budget rail first in a multi-rail 402 | The client picks the in-policy rail, never the trap |

Plus the SDK's `evaluatePolicy` (the exact guard the MCP delegates to) hammered
directly: per-call boundary at 0/6/18-decimal scales (floors, never rounds up),
lifetime accumulation boundary, host **suffix-spoof** vectors
(`example.com.evil.com` denied) for exact + wildcard patterns, case-insensitive
token matching, the `allowUnknownTokens` opt-in risk, and the `chains` allowlist.

### 04 · Config & SDK-consumption surface (in-process, exhaustive)
Drives the **public exports** of `@piprail/mcp` + `@piprail/sdk` to prove
everything the MCP grabs from the SDK is wired right: **every** EVM preset in
`CHAINS` and **every** non-EVM family is accepted with the correct chain-aware
default token; **every** wallet format maps correctly
(every chain → `{key}`; NEAR → `{accountId, key}`);
the budget → `PaymentPolicy` mapping; banner formatting with secret + RPC
redaction; chain warnings (TON/Tron); the `VERSION` single-source-of-truth
(`version.ts` == `package.json` == `server.json`); and the SDK's
`paymentTools(client)` shape the server wraps.

### 05 · LIVE caps under real on-chain settlement (the definitive proof)
On a forked Base with a payer holding **100 fake USDC** (so only the *policy*
can stop a payment, never the balance), policy `maxAmount 0.05 / maxTotal 0.10`,
driven through 6 real payments via the MCP:

1. `0.06` → **refused** (per-call cap) · 0 moved
2. `0.05` → settles (per-call boundary, exactly at cap)
3. `0.04` → settles (total 0.09)
4. `0.04` → **refused** (lifetime cap; would be 0.13) · 0 moved
5. `0.01` → settles (lifetime boundary, exactly 0.10)
6. `0.01` → **refused** (at the cap) · 0 moved

On-chain ground truth: the payer spent **exactly 0.10**, the merchant received
**exactly 0.10** — not a base unit more — despite a 100-USDC wallet. Declined
calls moved **zero**.

---

## A real inconsistency this harness caught (and fixed)

While building suite 02 it found a terminology gap: the accept side allows the
chain's coin with `token: 'native'`, but the **payer's** policy allowlist matched
only the coin's *symbol* — so `PIPRAIL_TOKENS=native` silently allowed nothing,
and you had to know each chain's ticker (`ETH`, `TRX`, `XLM`, …). That broke the
"name the chain, not the ticker" consistency PipRail aims for. The SDK's
`evaluatePolicy` now accepts **`'native'`** as a chain-agnostic alias (matched on
the asset, working on every family; the real ticker still works; a stablecoin
allowlist is never loosened), `@piprail/mcp`'s docs use `native`, and suite 02
locks the behavior so it can't regress. (Proof the harness earns its keep.)

---

## Layout

```
examples/mcp-sandbox/
├── run-all.mjs              # runs all five suites → one combined PASS/FAIL
├── suites/
│   ├── 01-protocol.mjs      # handshake / schemas / config errors / banner
│   ├── 02-tools.mjs         # full quote/plan/pay I/O, POST+body, multi-rail, native
│   ├── 03-policy-attacks.mjs# hostile merchant + evaluatePolicy hammering
│   ├── 04-config-surface.mjs# every chain/family/wallet format + versions (in-process)
│   └── 05-live-settlement.mjs# real on-chain caps (Anvil fork of Base)
└── lib/
    ├── harness.mjs          # spawn the real dist/bin.js, talk MCP over stdio
    ├── merchant.mjs         # HONEST x402 merchant (SDK requirePayment)
    ├── hostile-merchant.mjs # crafts lying/spoofed 402 envelopes
    └── report.mjs           # tiny dependency-free check runner
```

## How `@piprail/mcp` uses `@piprail/sdk` (confirmed by this harness)

`PIPRAIL_*` env → `parseConfig` → `configToClientOptions` (your budget becomes a
`PaymentPolicy`) → `new PipRailClient(opts)` → `paymentTools(client)` exposes the
5 tools over MCP. Every payment flows through the client's `authorize()`, which
enforces the policy **before** `payAndConfirm` ever touches the chain. The MCP
package adds **no** chain logic of its own — it's config + wiring; the spend guard
lives in `@piprail/sdk`'s `policy.ts` / `client.ts`.

## See also

- [`../mcp`](../mcp) — build a minimal MCP server from scratch (~50 lines)
- [`../../mcp`](../../mcp) — the published, zero-code `@piprail/mcp` server
- [`../agent`](../agent) — the same `PipRailClient` + policy, without MCP
- [SDK docs](../../sdk/README.md) · [Model Context Protocol](https://modelcontextprotocol.io/)

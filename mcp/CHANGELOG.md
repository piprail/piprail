# @piprail/mcp changelog

## 0.3.3 — 2026-06-13 — rebuilt against SDK 1.21.1 (facilitator hardening + agent guide)

No MCP code change — pins `@piprail/sdk` to `^1.21.1`, which hardens the gasless `exact` rail and
teaches the **agent guide** about it. The MCP exposes that guide (`piprail_guide` / the
`piprail://guide` resource), so an agent now reads how the gasless rail works, that it's operator-opt-in
(`PIPRAIL_SCHEMES=onchain-proof,exact`), and how to recover from an `exact` timeout (the `.ref` is an
authorization nonce — re-present, never re-sign). Also: gasless auto-routing now works on Solana, a
third-party facilitator can't settle Permit2 (clear error), and the buyer's EIP-3009 domain read
tolerates a flaky RPC. The `PIPRAIL_SCHEMES` description is corrected (exact is gasless on **EVM +
Solana**, method auto-selected — not "EVM + EIP-3009 only"). See
[docs.piprail.com/mcp](https://docs.piprail.com/mcp/configuration/).

## 0.3.2 — 2026-06-13 — Solana `exact` (gasless) via the SDK

No MCP code change — this pins `@piprail/sdk` to `^1.21.0`, which adds the standard x402 **`exact`**
rail on **Solana**. Set `PIPRAIL_CHAIN=solana` + `PIPRAIL_SCHEMES=onchain-proof,exact` and the wallet
pays standard Solana `exact` servers **gasless** — any SPL token (USDC/USDT), with a facilitator (e.g.
PayAI) covering the gas so the wallet spends zero SOL. See
[docs.piprail.com/mcp](https://docs.piprail.com/mcp/configuration/).

## 0.3.1 — 2026-06-10 — docs consolidation: README points to docs.piprail.com

Docs-only. No code, no tool, no behaviour change.

- **`README.md` trimmed to a signpost** — the full MCP manual (per-client config, the complete env-var
  reference, modes, per-chain setup, the tools reference) now lives at **[docs.piprail.com/mcp](https://docs.piprail.com/mcp/overview/)**,
  the single source of truth. The README keeps the pitch, the one minimal config block, the 7-tool line,
  the registry id, and a docs link table.

## 0.3.0 — 2026-06-10 — the trusted agent wallet (Mode A time envelope + Mode B ask-before-pay)

Rebuilt against the SDK's trusted-wallet layer. All additive; the zero-config posture is byte-identical.

- **Time envelope (Mode A):** `PIPRAIL_TTL` (session deadline, in seconds), plus an optional rolling
  rate-limit `PIPRAIL_WINDOW_TOTAL` + `PIPRAIL_WINDOW_SECONDS` (set both or neither). Surfaced in the banner.
- **Ask-before-pay (Mode B):** `PIPRAIL_CONFIRM=1` wires the SDK's `onBeforePay` seam to MCP
  `elicitInput()` — a supervised client (Claude Desktop / Cursor) is asked to approve each payment.
  Fail-safe to NOT paying on decline/cancel/timeout/transport-drop; silently degrades to Mode A on a
  client that can't elicit; never carries a secret. `PIPRAIL_CONFIRM_TIMEOUT_MS` (default 55000, below the
  60s CallTool deadline) tunes the window. A declined pay is TERMINAL — the agent must not auto-retry.
- **Agent guide + budget (`PIPRAIL_GUIDE`, default on):** exposes `PIPRAIL_AGENT_GUIDE` as the
  `piprail_agent_guide` prompt + a `piprail://guide` resource, and a live `piprail://budget` resource.
- **Two new tools** — `piprail_budget` (remaining money + time leash) and `piprail_guide` (the contract),
  both read-only. Tool count is now **7**.
- **Structured output:** every tool result is emitted as `structuredContent` alongside the text block,
  with an `outputSchema` forwarded for the stable read tools.

## 0.2.9 — 2026-06-10

- **Rebuilt against `@piprail/sdk` ^1.14.0** — the opt-in universal `exact` BUYER rail.
- **`PIPRAIL_SCHEMES`** — opt into paying standard x402 servers. Set `PIPRAIL_SCHEMES=onchain-proof,exact`
  to let the wallet ALSO pay the standard `exact` rail (EVM + EIP-3009 / USDC), not just PipRail's
  backendless `onchain-proof` rail. Unset ⇒ `onchain-proof` only, so the zero-config posture is unchanged.
  The active schemes appear in the startup banner only when set. No custody/policy change.

## 0.2.8 — 2026-06-10

- **Rebuilt against `@piprail/sdk` ^1.13.0** — the conformance bug-hunt fixes + the gate `discovery`
  option. The `piprail_register` tool description now notes that index/agent payers are standard `exact`
  clients (advertise an `exact` rail to be payable, not just listed). No custody/policy change.

## 0.2.6 — 2026-06-09

- **Rebuilt against `@piprail/sdk` ^1.11.0** — the agent-friendly discovery lifecycle. The
  `piprail_register` tool now returns `visibility` + `note` per index and its description reflects
  the corrected 402 Index reality (a self-registered listing is **pending review** — verify your
  domain for instant approval — not "searchable within seconds"). No custody/policy change.

## 0.2.5 — 2026-06-09

- **Rebuilt against `@piprail/sdk` ^1.10.0** — the SDK's new standard x402 `exact` rail + v2
  conformance fixes (UTF-8-safe envelope codec, conformant rejection bodies). The MCP is the
  payer side, so there's **no server behaviour change**; this just pins the latest SDK.

## 0.2.4 — 2026-06-08

- **Kaia support (via `@piprail/sdk` ^1.9.0).** Bumped the SDK dependency so the server can pay on
  **Kaia** (ex-Klaytn, chainId 8217) — native KAIA or Tether-native USD₮. No server code change; set
  `PIPRAIL_CHAIN=kaia`. Now 29 chains in total.

## 0.2.3 — 2026-06-06

- **Richer registry listing.** `server.json` now sets `title` ("PipRail"), `websiteUrl`
  (https://piprail.com/mcp), and `repository.subfolder` ("mcp"). Because the MCP directories
  (PulseMCP, Glama, mcp.so, …) ingest from the Official MCP Registry, these enrich the listing
  *everywhere* at once — a clean display name, a homepage link, and a precise pointer to the
  server's path in the monorepo. No code change to the server.

## 0.2.2 — 2026-06-06

- **Tool annotations on the wire.** `ListTools` now advertises each tool's advisory annotations
  (`title`, `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) straight from the SDK
  (`@piprail/sdk` ≥ 1.8.0, now the required range), so an MCP client can reason about each tool and
  render the right consent — the three reads (`piprail_discover` / `quote` / `plan`) are flagged
  **read-only**, `piprail_pay_request` is flagged **value-moving** (the only tool that spends), and
  `piprail_register` is non-destructive. Hints only — the spend policy is still the real boundary.

## 0.2.1 — 2026-06-06

- **Fix:** the `VERSION` constant (`src/version.ts`) was left at `0.1.0` in the 0.2.0 release, so the
  server self-reported `0.1.0` in its banner and MCP handshake while the package was `0.2.0`. Now
  synced to `0.2.1` across `version.ts` + `package.json` + `server.json`, with a guard test
  (`version.test.ts`) so the three can never drift again. No functional change to the 0.2.0 tools.

## 0.2.0 — 2026-06-06

- **Discovery tools (via `@piprail/sdk` ≥ 1.7.0).** The server now exposes **five** tools — the two
  new ones flow through the SDK's `paymentTools` automatically (zero server code): **`piprail_discover`**
  (find payable x402 resources on the open indexes — CDP Bazaar + 402 Index, free) and
  **`piprail_register`** (list a resource the agent runs on 402 Index — no auth, no signature). The
  startup banner now lists all five (`piprail_discover` · `piprail_quote_payment` ·
  `piprail_plan_payment` · `piprail_pay_request` · `piprail_register`). The `@piprail/sdk` dependency
  range is bumped to `^1.7.0` accordingly.
- **Docs:** `PIPRAIL_TOKENS` now documents the chain-agnostic `native` alias (allow the chain's
  coin on any family without naming its ticker) across the README, `.env.example`, `server.json`,
  and the `Config` JSDoc — it's a passthrough to `@piprail/sdk`'s `policy.tokens` (SDK ≥ 1.6.0).

## 0.1.0 — 2026-06-05

Initial release. A Model Context Protocol server wrapping [`@piprail/sdk`](https://www.npmjs.com/package/@piprail/sdk).

- Exposes the SDK's three agent tools over stdio: `piprail_quote_payment`, `piprail_plan_payment`, `piprail_pay_request` (JSON Schema passed straight through the low-level MCP `Server` — no Zod).
- Env-configured (`PIPRAIL_*`, with `AGENT_KEY` alias), validated fail-fast.
- Budget-bound by the SDK spend policy (`maxAmount` / `maxTotal` / `tokens` / `hosts`), enforced before any on-chain send.
- Per-family wallet mapping — one secret env var works on EVM, Solana, TON, Tron, NEAR, Sui, Aptos, Algorand, Stellar, and XRPL.
- Chain-aware default token: `USDC` everywhere, but `USDT` on Tron & TON (native USDC doesn't exist there) — overridable via `PIPRAIL_TOKENS`.
- Startup `⚠ notes:` for chains that need a keyed RPC (TON effectively required, Tron recommended) — keys fold into `PIPRAIL_RPC_URL` (the SDK has no separate key field).
- `npx -y @piprail/mcp`; ESM; Node ≥ 20. Stderr-only logging (stdout is the protocol channel).

# PipRail discovery — status & integration log

How a PipRail user — a human merchant **or** an AI agent — becomes **discoverable**, and how an
agent **finds** payable resources.

> ### 📖 The full reference now lives at → **[docs.piprail.com/discovery](https://docs.piprail.com/discovery/discover-and-register/)**
> The three moves (EMIT / REGISTER / DISCOVER), the every-chain guarantee, the `discoverySigner`
> primitive, the agent/MCP tools, the emitters, and the full API surface are documented there —
> the single **source of truth**. This file keeps only the **internal experimental-status record**
> below, which is not user docs.

**One line:** PipRail makes you discoverable by building on the **open** x402 indexes that already
exist (402 Index, the CDP Bazaar read API, x402scan) — **it hosts nothing of its own**: no
registry, no database, no backend, no fee. Every piece is opt-in; the pay path is untouched.

> **⚠️ Status: EXPERIMENTAL.** Discovery integrates with **third-party** open indexes whose wire
> shapes are a moving, unratified convention — treat this whole layer as experimental and expect to
> re-verify the integration over time. The **read** path + the **402 Index register** flow are
> live-verified (see the log below); **x402scan SIWX is not yet live-tested** — exercise it against
> x402scan before relying on it. The pay path and the rest of the SDK are stable; only this layer
> carries the experimental flag. Code of record: `src/discovery.ts` + `src/indexes.ts`.

---

## Experimental status & live-integration log

Discovery is **experimental** because it depends on third-party open indexes (402 Index, CDP Bazaar,
x402scan) whose APIs and conventions are young and moving. The SDK code is stable and tested; what's
experimental is the *integration contract* with those external services. Keep this log current.

**Live integration test — 2026-06-06** (the SDK's own functions, run against the real services):

| What | Result |
|---|---|
| `searchOpenIndexes({ sources: ['bazaar'] })` — CDP Bazaar, free | ✅ 20 resources normalized; all `exact`-scheme on `eip155:8453` (confirms the cross-scheme caveat). |
| `searchOpenIndexes({ sources: ['402index'], query })` | ✅ real `{services:[…]}` parsed; the **x402 protocol filter dropped L402/MPP** on live data. |
| `client.discover({ network: 'any' })` | ✅ both indexes merged + deduped (sources: `bazaar` + `402index`). |
| `client.discover()` (default `self`) | ✅ filtered to the client's chain; the never-hide invariant held on real data. |
| `register402Index(...)` (write, no auth) | ✅ POST succeeded end-to-end; **402 Index PROBES the URL** and returned **HTTP 422** for a non-402 URL: *"Your endpoint returned HTTP 200 instead of 402."* Our code reported `{ ok:false, status:422, detail }` **without throwing**, and surfaces the index's own reason. |
| `registerX402Scan(...)` (SIWX write) | ⏳ **NOT yet live-tested.** EVM signing is correct in isolation, but the SIWX handshake against x402scan is unverified — still experimental. |
| **`User-Agent` attribution** | ✅ confirmed sent over the wire (`@piprail/sdk (+https://piprail.com)` echoed back by an external header service). |
| **Opt-in `via` listing tag** | ✅ confirmed **safe**: a `register(..., { attribution: true })` to 402 Index returns the *identical* URL-probe response as an untagged one — the field is tolerated, never causes a rejection. |

**Key facts learned live:**
- **402 Index validates by probing** — it will only list a URL that actually returns a `402`. So a
  successful registration requires a **real, deployed, public** x402 endpoint (PipRail has none to
  test with — a marketing site returns 200 and is correctly rejected). This also means our test
  created **no junk listing**. The error reason is now surfaced in `RegisterOutcome.detail`.
- **Read is free and works today** on both CDP Bazaar and 402 Index with no key.
- **402 Index totals (2026-06-06):** ~63k endpoints (x402: ~61k), ~1.6k services — a real, populated index.

**Before relying on it in production:** (1) register a real deployed x402 endpoint and confirm a
`200`/listed outcome end-to-end; (2) live-test the x402scan SIWX path; (3) re-verify the index wire
shapes (they drift — the parser is defensive but the conventions are unratified).

---

## Sources & further reading

- [Discovery docs](https://docs.piprail.com/discovery/discover-and-register/) — the complete, current reference.
- `.claude/research/x402-discovery.md` — the from-scratch explainer (concepts, formats, glossary).
- `.claude/research/x402-discovery-integration.md` — the source-level integration plan + verification log.
- 402 Index — https://402index.io · CDP Bazaar — https://docs.cdp.coinbase.com/x402/bazaar ·
  x402scan — https://github.com/Merit-Systems/x402scan · x402 spec — https://github.com/coinbase/x402

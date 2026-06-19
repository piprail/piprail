# `sdk-sandbox` — end-to-end proof that `@piprail/sdk` works, both ends

A runnable test harness that exercises the **whole SDK** as a real consumer would
— the **accept side** (`requirePayment` / `createPaymentGate`), the **pay side**
(`PipRailClient` *and* the multi-chain `MultiChainPayer`), the **agent toolkit**
(`paymentTools` — all 7 tools), and the **entire public API surface** — against
real local HTTP merchants, fake heterogeneous drivers, and a **real on-chain
round-trip** (a local Anvil fork of Base, fake money). It complements the SDK's
in-tree unit suite by proving the **published artifact** (currently `@piprail/sdk`
≥ 1.24.0) behaves end to end, and it doubles as living documentation.
**284 checks, all green.**

```bash
# Tests the installed @piprail/sdk (bump it in package.json to test a new release):
cd examples/basics/sdk-sandbox && npm install
node run-all.mjs        # or: npm test
```

```text
▸ 01 · createPaymentGate / requirePayment — the ACCEPT side
▸ 02 · PipRailClient read-only — quote / estimateCost / planPayment / canAfford
▸ 03 · the spend policy under attack (hostile merchant + onBeforePay + core)
▸ 04 · wire codecs round-trip + the typed error taxonomy
▸ 05 · LIVE round-trip on a Base fork — accept ↔ pay, USDC + native
▸ 06 · discovery — emit (OpenAPI/.well-known/DNS) + discoverySigner
▸ 09 · multi-chain — MultiChainPayer / planAcross / fetchAcross (one wallet per chain)
▸ 10 · agent toolkit — all 7 tools on PipRailClient AND MultiChainPayer
▸ 11 · API-surface sweep — every export reachable + every chain-free helper invoked
── summary ──
ALL 284 CHECKS PASSED
```

> There are **two** sandboxes. [`../mcp-sandbox`](../mcp-sandbox) proves the
> `@piprail/mcp` server (spawned over stdio) can't be made to overspend. **This
> one** proves the underlying `@piprail/sdk` — both the merchant gate and the
> payer client — works end to end.

## Is it safe to run? (yes — no real money, no real keys)
All keys are throwaway constants generated in-process. Suites 01–04 never
broadcast a transaction (they quote/plan, or pay things the policy declines, and
point at a dead RPC so they're **offline**). Suite 05 forks Base into a local
Anvil and deals itself *fake* USDC by writing contract storage; every "real"
payment settles on that disposable fork, which is killed at the end.

`05` defaults to forking via `https://mainnet.base.org` (override
`BASE_FORK_RPC`). If Foundry's `anvil` or the RPC is unavailable it **skips
cleanly** — never a failure.

## Both ends, fully covered

### The ACCEPT side — `createPaymentGate` / `requirePayment` (suite 01 + 05)
- `challenge()` builds a correct x402 envelope (scheme, network, **base-unit**
  amount, asset, payTo, decimals/symbol/nonce/minConfirmations, maxTimeoutSeconds).
- the `payment-required` header **round-trips** through `parseChallenge`.
- every `verify()` branch: no-proof → re-challenge; garbage header → re-challenge
  (lenient, never 500s); proof for an **unoffered** asset → `transfer_not_found`;
  a well-formed proof for a **non-existent tx** → `tx_not_found` (never throws);
  `toInvalidBody` shapes the canonical 402.
- multi-accept challenges (several rails under one shared nonce).
- guards: passing both/neither form throws; a wrong-family `payTo` →
  `WrongFamilyError`.
- **live:** a real proof verifies once → `paid`; the **same proof again** →
  `tx_already_used` (the used-proof set defeats double-spend).

### The PAY side — `PipRailClient` (suites 02–05)
- read-only: `quote` (full shape), `estimateCost` (quote + native-coin gas,
  `basis` labelled, never throws), `planPayment` (typed `blockers`/`warnings`,
  graceful degradation on a dead RPC), `canAfford`, the `spent()` ledger, and
  `get`/`post` on a non-402.
- **the spend policy can't be broken** (suite 03): a hostile merchant lying about
  decimals / display amount / symbol can't push the client over its cap (the cap
  binds to the token's **true** value); at-cap allowed / +1 refused; unpriceable
  assets refused; multi-rail traps avoided; `onBeforePay` is the final say
  (returning `false` **or throwing** declines, fail-safe); and `evaluatePolicy`
  is hammered across decimals scales, lifetime accumulation, host suffix-spoofs,
  the `tokens` allowlist (incl. the chain-agnostic **`native`** alias), `chains`,
  and `allowUnknownTokens`.
- typed errors are reachable with stable `.code`s (suite 04):
  `INVALID_ENVELOPE`, `NO_COMPATIBLE_ACCEPT`, `NON_REPLAYABLE_BODY`,
  `UNKNOWN_TOKEN`, `WRONG_FAMILY`, `PAYMENT_DECLINED`, and (live)
  `INSUFFICIENT_FUNDS`.
- **live (suite 05):** `client.fetch` pays a real `402` → on-chain transfer →
  the gate verifies it → `200` + receipt, for **USDC and the native coin**;
  `planPayment` reports `payable` with real balances; and the **lifetime cap
  holds across real settlements** (third over-cap payment refused, zero moved).

### Multi-chain, agent toolkit & full API surface (suites 09–11)
- **multi-chain (09):** a `MultiChainPayer` over fake heterogeneous chains
  (EVM + Solana + XRPL) pays the **first funded chain you listed** that can settle,
  skips a blocked chain for a funded one, surfaces a **merged decline naming every
  chain's blocker**, throws `PaymentDeclinedError` before any send, merges/dedupes
  `discover`, propagates `schemes` (gasless `exact` opt-in) to every chain, and
  enforces its constructor guards — plus the `planAcross`/`fetchAcross` primitives.
- **agent toolkit (10):** every one of the **7 tools** (`discover`/`quote`/`plan`/
  `pay`/`register`/`budget`/`guide`) invoked and shape-checked on **both** a
  single-chain `PipRailClient` and a `MultiChainPayer` (proving `PayingClient`
  parity), including the structured-decline path (never a thrown crash).
- **API-surface sweep (11):** asserts **every** promised value-export is defined (a
  release tripwire), then actually invokes the chain-free helpers — renderers,
  `classifyChallenge`, `buildSelfDescription` + `renderLandingPage`, the discovery
  builders, the index + facilitator data maps, the exact/permit2 codecs &
  constants, `resolveChain`, `evaluatePolicy` (allow + every deny), and the typed
  errors' stable `.code`s.

## Layout
```
examples/sdk-sandbox/
├── run-all.mjs              # suites 01–06 + 09–11 → one combined PASS/FAIL
├── suites/
│   ├── 01-merchant-gate.mjs # createPaymentGate / requirePayment / verify / errors
│   ├── 02-client-readonly.mjs# quote / estimateCost / planPayment / canAfford / spent
│   ├── 03-policy.mjs         # hostile merchant + onBeforePay + evaluatePolicy core
│   ├── 04-wire-and-errors.mjs# x402 codecs round-trip + typed error taxonomy
│   ├── 05-live-roundtrip.mjs # real on-chain accept↔pay (USDC + native) on a Base fork
│   ├── 06-discovery.mjs      # emit (OpenAPI/.well-known/DNS) + discoverySigner
│   ├── 09-multichain.mjs     # MultiChainPayer / planAcross / fetchAcross (fake heterogeneous drivers)
│   ├── 10-agent-toolkit.mjs  # all 7 paymentTools on PipRailClient AND MultiChainPayer
│   └── 11-api-surface.mjs    # every export reachable + every chain-free helper invoked
│   # (07-exact-rail / 08-x402-interop run individually — they need Foundry anvil / @x402)
└── lib/
    ├── merchant.mjs          # honest gate-based merchant (requirePayment)
    ├── hostile.mjs           # hand-crafted lying 402 envelopes
    └── report.mjs            # tiny dependency-free check runner
```

## See also
- [`../mcp-sandbox`](../mcp-sandbox) — the same rigor for the MCP server
- [`../agent`](../agent) · [`../express`](../express) — minimal copy-paste apps
- [Docs](https://docs.piprail.com) · [Error model](https://docs.piprail.com/errors/error-model/) · [STANDARDS.md](../../../sdk/STANDARDS.md)

# `sdk-sandbox` — end-to-end proof that `@piprail/sdk` works, both ends

A runnable test harness that exercises the **whole SDK** as a real consumer would
— the **accept side** (`requirePayment` / `createPaymentGate`) *and* the **pay
side** (`PipRailClient`) — against real local HTTP merchants and a **real
on-chain round-trip** (a local Anvil fork of Base, fake money). It complements
the SDK's in-tree unit suite by proving the **published artifact** behaves end to
end, and it doubles as living documentation. **86 checks, all green.**

```bash
# From the repo root (tests your LOCAL build):
npm run build:sdk
cd examples/sdk-sandbox
node run-all.mjs
```

```text
▸ 01 · createPaymentGate / requirePayment — the ACCEPT side
▸ 02 · PipRailClient read-only — quote / estimateCost / planPayment / canAfford
▸ 03 · the spend policy under attack (hostile merchant + onBeforePay + core)
▸ 04 · wire codecs round-trip + the typed error taxonomy
▸ 05 · LIVE round-trip on a Base fork — accept ↔ pay, USDC + native
── summary ──
ALL 86 CHECKS PASSED
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

## Layout
```
examples/sdk-sandbox/
├── run-all.mjs              # all five suites → one combined PASS/FAIL
├── suites/
│   ├── 01-merchant-gate.mjs # createPaymentGate / requirePayment / verify / errors
│   ├── 02-client-readonly.mjs# quote / estimateCost / planPayment / canAfford / spent
│   ├── 03-policy.mjs         # hostile merchant + onBeforePay + evaluatePolicy core
│   ├── 04-wire-and-errors.mjs# x402 codecs round-trip + typed error taxonomy
│   └── 05-live-roundtrip.mjs # real on-chain accept↔pay (USDC + native) on a Base fork
└── lib/
    ├── merchant.mjs          # honest gate-based merchant (requirePayment)
    ├── hostile.mjs           # hand-crafted lying 402 envelopes
    └── report.mjs            # tiny dependency-free check runner
```

## See also
- [`../mcp-sandbox`](../mcp-sandbox) — the same rigor for the MCP server
- [`../agent`](../agent) · [`../express`](../express) — minimal copy-paste apps
- [Docs](https://docs.piprail.com) · [Error model](https://docs.piprail.com/errors/error-model/) · [STANDARDS.md](../../sdk/STANDARDS.md)

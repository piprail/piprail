# a2a-server — PipRail mounted in a real `@a2a-js/sdk` server

Proves the documented A2A integration **actually runs** against the official A2A JS runtime
([`@a2a-js/sdk`](https://github.com/a2aproject/a2a-js) — the `a2aproject` org / Linux Foundation A2A
project, Google-maintained) — not just the spec or our own harness. It mounts the PipRail A2A seller handler
(`createA2APaymentHandler`) inside `@a2a-js/sdk`'s `DefaultRequestHandler` via an `AgentExecutor`, and
round-trips a request **in-process through the SDK's own request handler** (`handler.sendMessage` →
executor → event bus → `ResultManager` → `Task`).

If PipRail's `Task` survives the SDK's machinery with its `x402.payment.*` metadata intact, the mount
in [the A2A transport docs](https://docs.piprail.com/accepting-payments/a2a-transport/) genuinely
works.

## The adapter (`lib.mjs`)

PipRail's `handleMessage` returns a complete, metadata-bearing `Task`. The SDK is event-driven and
correlates events by **host-owned** identifiers (`messageId` / `artifactId` / `contextId`), so the
executor stamps those before `bus.publish(task)` — PipRail's A2A types are transport metadata only
(zero `@a2a` dependency, by design), and the adapter is where the runtime's identifiers belong.

## Run it

```bash
npm install      # @piprail/sdk@^2.11.0 + @a2a-js/sdk@^0.3
npm test         # in-process round-trip through the real SDK
```

> The bogus-proof assertion expects `payment-failed` (the spec §9 merchant status). That landed in the
> A2A status fix; until that SDK version is published, run `npm test` against the workspace build
> (`npm pack` the local `sdk/`, then `npm install --no-save <tgz>` here) — the release bumps this pin.

What `test.mjs` asserts: the SDK-served AgentCard advertises the x402 extension; a service request
returns a `Task` whose `x402.payment.required` challenge (x402Version 2) reaches the client through
the `ResultManager`; the SDK preserves `id`/`contextId`/`messageId`; and a bogus proof re-challenges
as `payment-failed` (the spec §9 merchant status — retry rides on the `input-required` Task state)
without ever throwing.

> The live **on-chain settle** over A2A (a real Base-mainnet payment through `handleMessage`) is
> covered by [`../basics/x402-parity-sandbox/suites/04-a2a-google.mjs`](../basics/x402-parity-sandbox/suites/04-a2a-google.mjs).
> This example proves the **`@a2a-js/sdk` runtime wiring**; that one proves the **settlement**.

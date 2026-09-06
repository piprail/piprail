---
title: Why it's safe
description: 'The spend policy is enforced by the SDK before any on-chain send, against the token''s true decimals. No custody, no backend, and the key stays local.'
sidebar:
  order: 8
---

## Introduction

The MCP server hands a model a wallet, so the question that matters is: *what stops it
overspending?* The answer is the same in every case: **the spend policy is the boundary, and the
SDK enforces it before anything moves on-chain.** The model never reaches the wallet directly; it
goes through `piprail_pay_request`, which checks the policy first and only signs if it passes.

## The spend policy is the boundary

`PIPRAIL_MAX_AMOUNT`, `PIPRAIL_MAX_TOTAL`, `PIPRAIL_TOKENS`, and `PIPRAIL_HOSTS` are enforced by
the SDK **before any on-chain send**. An over-budget or off-policy request comes back as a
declined result and **nothing moves**. The model cannot overspend even if it tries.

```jsonc
{
  "PIPRAIL_MAX_AMOUNT": "0.10",   // per-payment ceiling
  "PIPRAIL_MAX_TOTAL": "10.00",   // lifetime cap, per token
  "PIPRAIL_TOKENS": "USDC",       // only these symbols (+ `native` for the coin)
  "PIPRAIL_HOSTS": "*.example.com" // optional: only these hosts
}
```

When a request breaches the policy, the tool returns a structured refusal,
`{ declined: true, reason, reasonCode: 'POLICY' }`, instead of paying; **nothing moves**. The
defaults are deliberately small and safe (**0.10 per payment, 10.00 lifetime per token, USDC on
Base**) so a misconfigured or zero-config server still can't drain a wallet.

:::note
The budget *is* the consent in the default headless mode. There's no per-payment prompt because
the policy already drew the line. See [Modes](/mcp/modes/) for the supervised alternative, where a
human approves each spend on top of the policy.
:::

## Checked against the token's true decimals

A price in a `402` challenge is just a number; its meaning depends on the token's decimals. The
SDK resolves the **token's true on-chain decimals** and evaluates the cap against the real base
amount, so a malicious server can't slip past a limit by understating a price or claiming the
wrong decimals.

```text
Server says "0.10". SDK resolves USDC = 6 decimals → 100000 base units.
Cap is 0.10 → 100000 base units. Equal: allowed.
A server that mislabels the token can't make a 100.00 payment look like 0.10.
```

This is why `PIPRAIL_ALLOW_UNKNOWN_TOKENS` defaults to `false`: a token the SDK can't price has no
trustworthy decimals to check the cap against, so it's refused rather than guessed at. Keep it
`false`.

## No custody, no backend

The server runs **on your machine, with your key, against your RPC.** PipRail runs no service and
holds nothing. Payments settle wallet-to-wallet, straight from your wallet to the resource's
`payTo`. There is no facilitator in the path and no account to sign up for.

The wallet secret is read **once**, from the environment, and **never logged.** Only the *name* of
the env var that supplied it is surfaced in the startup banner, never the value:

```bash
export PIPRAIL_PRIVATE_KEY=0xYOUR_PRIVATE_KEY   # stays in your process; never printed
npx -y @piprail/mcp
```

:::caution
Configuration is via environment variables, **never CLI arguments**, because a key in `argv` leaks into
process listings and shell history. Put it in your client's `env` block or export it; never commit
it. See [Client setup](/mcp/client-setup/) for the per-client config.
:::

## The typo guard

A mistyped policy var is a silent footgun: `PIPRAIL_MAX_AMUONT` would be ignored, and the cap you
*thought* you set wouldn't apply. The config layer refuses to start on any unrecognized `PIPRAIL_*`
variable, naming the offender and listing the valid ones:

```text
Unknown PipRail config var(s): PIPRAIL_MAX_AMUONT.
Valid vars: PIPRAIL_PRIVATE_KEY, PIPRAIL_WALLET_KEY, PIPRAIL_CHAIN, PIPRAIL_CHAINS, PIPRAIL_RPC_URL, PIPRAIL_MAX_AMOUNT, …
```

It fails loudly instead of running with a budget that isn't the one you meant. The same fail-fast
applies to an unknown `chain` and to a half-armed rolling window (`PIPRAIL_WINDOW_TOTAL` and
`PIPRAIL_WINDOW_SECONDS` must be set together or neither).

## Open source and auditable

The boundary is code you can read. `@piprail/mcp` and `@piprail/sdk` are **MIT-licensed and open
source**. The policy check, the decimals resolution, and the wallet handling are all in the open,
with no backend you'd have to take on trust. The config parser is pure and side-effect-free: it
takes an env object you pass in and never touches `process.env` itself, so the exact rules above
are unit-tested.

If you want to embed the same checks in your own process rather than run the server, the config
parser and client-options builder are exported; see [Use it as a library](/mcp/use-as-a-library/).
The policy semantics themselves are documented under [Payment policy](/spend-controls/payment-policy/)
and [Evaluating a policy](/spend-controls/evaluate-policy/).

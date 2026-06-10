---
title: "Modes — headless & supervised"
description: How the MCP server decides whether to pay — Mode A where the spend policy is the consent, and the opt-in Mode B that asks a human to approve each payment.
sidebar:
  order: 6
---

## Introduction

The MCP server runs in one of two modes. **Mode A (headless)** is the default: the
[spend policy](/spend-controls/payment-policy/) you configure *is* the consent, so the agent
pays autonomously up to its caps with no per-payment prompt. **Mode B (supervised)** is opt-in:
it additionally asks a human to approve each fund-moving payment, in the host's own UI, at the
moment of spend.

Mode B is **additive** — it layers on top of the policy, it never replaces it. The budget gate
always runs first; the confirmation only ever sees a payment that already passed it. There is no
way to confirm your way past a spend cap.

## Mode A — headless (default)

With no extra configuration, the server is headless. Every payment passes through the spend
policy before any on-chain send; if it's within the caps, it settles without asking.

```jsonc
{
  "env": {
    "PIPRAIL_PRIVATE_KEY": "0xYOUR_PRIVATE_KEY",
    "PIPRAIL_CHAIN": "base",
    "PIPRAIL_MAX_AMOUNT": "0.10",   // per-payment ceiling
    "PIPRAIL_MAX_TOTAL": "10.00"    // lifetime ceiling per token
  }
}
```

A payment that breaches the policy is refused **before any funds move**. The
[`piprail_pay_request`](/mcp/tools/) tool doesn't throw — it returns a structured refusal the
model can read and reason about (the SDK raises a `PaymentDeclinedError`, which the tool funnels
into this object):

```jsonc
{
  "ok": false,
  "declined": true,
  "code": "PAYMENT_DECLINED",
  "reasonCode": "POLICY",   // typed cause the model can branch on
  "reason": "payment of 100000 base units exceeds policy.maxAmount (0.10 USDC).",
  "explain": "payment of 100000 base units exceeds policy.maxAmount (0.10 USDC)."
}
```

`reasonCode` is the typed half (`POLICY` / `BUDGET` / `OUTSIDE_WINDOW` / `SESSION_EXPIRED` /
`APPROVAL`); `reason` is the SDK's human sentence, derived from the **true** on-chain decimals so
a server can't slip past a cap by understating its price.

:::note
The policy is the leash, and the model can't loosen it. `PIPRAIL_MAX_AMOUNT`,
`PIPRAIL_MAX_TOTAL`, the [token allowlist](/spend-controls/payment-policy/), and the optional
[time envelope](/spend-controls/time-envelope/) are read from env at startup; tools see only the
already-gated client.
:::

## Mode B — supervised (`PIPRAIL_CONFIRM=1`)

Set `PIPRAIL_CONFIRM=1` to wire the SDK's `onBeforePay` seam to the MCP
`server.elicitInput()` call. Now, after a payment clears the policy, the host (Claude Desktop,
Cursor, …) shows a human a one-line approval form — and no funds move unless they explicitly
check approve.

```jsonc
{
  "env": {
    "PIPRAIL_PRIVATE_KEY": "0xYOUR_PRIVATE_KEY",
    "PIPRAIL_CHAIN": "base",
    "PIPRAIL_CONFIRM": "1"
  }
}
```

The prompt reads, for example (the network is shown as its CAIP-2 id — `eip155:8453` is Base):

```text
Approve paying 0.10 USDC to api.example.com on eip155:8453?
```

Decline, cancel, or ignore it and the payment comes back as a clean refusal —
`{ ok: false, declined: true, code: "PAYMENT_DECLINED", reasonCode: "APPROVAL" }` — with nothing
spent.

### What the prompt shows — and never shows

The confirmation form is built only from the quote's own non-secret fields. It is **secret-free
by construction**: no wallet key, no RPC URL, not even the full URL — only the **host** (the
path can carry query-string secrets).

| Shown | Withheld |
| --- | --- |
| Amount + token symbol | Wallet key / seed |
| Recipient **host** (not the full URL) | RPC URL |
| Network (chain) | Query-string params |
| An unverified-token warning, where the symbol can't be confirmed on-chain | — |

:::caution
A token the SDK can't verify is **flagged** in the prompt and shown by its on-chain asset id,
not by a symbol the server merely claims. Mode B exists for exactly this kind of human vigilance
— if you see the warning, look before you approve.
:::

## Fail-safe: silence is "no"

Mode B refuses by default. Only an explicit approval authorises a payment; everything else —
decline, cancel, a round-trip timeout, a dropped transport, a validation error, or **any** throw
inside `elicitInput` — maps to *not paying*.

| Outcome | Result |
| --- | --- |
| Explicit approve | Payment settles |
| Decline / cancel | `{ declined: true, reasonCode: "APPROVAL", … }` |
| Timeout / transport drop / error | `{ declined: true, reasonCode: "APPROVAL", … }` |

The approval window defaults to 55 seconds — deliberately just under the MCP client's 60-second
call timeout, so a slow human times out *inside* the elicitation and the decline reaches the
agent as a clean refusal rather than an opaque transport error. To give a human longer to
deliberate, raise both `PIPRAIL_CONFIRM_TIMEOUT_MS` **and** your MCP client's own request
timeout.

```jsonc
{ "env": { "PIPRAIL_CONFIRM": "1", "PIPRAIL_CONFIRM_TIMEOUT_MS": "120000" } }
```

## Degrades silently on clients that can't elicit

Elicitation is a *client* capability. The server detects it at pay-time: a host that doesn't
advertise the elicitation form (or any elicitation at all) **silently degrades to Mode A** — the
payment proceeds under the policy alone, and the agent is never blocked by a prompt the host
can't render. Mode B never weakens the budget; degrading just drops the extra ask.

:::note
"Supported" here means the granular `elicitation.form` capability, resolved after the client
connects. Check your client's MCP support before relying on Mode B for hands-on approval; see
[Client setup](/mcp/client-setup/) for which hosts can elicit.
:::

## Choosing a mode

| | Mode A — headless | Mode B — supervised |
| --- | --- | --- |
| Trigger | default | `PIPRAIL_CONFIRM=1` |
| Per-payment human approval | no | yes (where the host can elicit) |
| Consent model | the spend policy | the policy **plus** a human |
| Best for | unattended agents, CI, servers | a person at the keyboard, larger or rare spends |

Mode A suits an agent running unattended within a tight budget. Mode B suits a human in the loop
who wants eyes on each spend — and falls back to Mode A automatically wherever the host can't ask.
In both modes the [spend policy](/spend-controls/payment-policy/) is the floor that always holds.

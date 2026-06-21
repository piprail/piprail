---
title: Configuration
description: Every PIPRAIL_* environment variable the MCP server reads — the wallet, the budget, the schemes, and the time envelope — and the wallet key format for each chain.
sidebar:
  order: 4
---

## Introduction

The MCP server is configured **entirely through environment variables** — never CLI
arguments. A key in `argv` leaks in process listings and shell history, so PipRail won't take
one there. Put every var in your MCP client's `env` block (see [Client
setup](/mcp/client-setup/)).

Canonical names are prefixed `PIPRAIL_`. The parser is strict: any unrecognized `PIPRAIL_*`
var is rejected as a typo at startup rather than silently ignored, so a misspelled name fails
loudly with the list of valid vars.

## The one requirement

Only the wallet secret is mandatory. Everything else has a safe default — `base`, USDC, 0.10
per payment, 10.00 lifetime per token.

```jsonc
"env": {
  "PIPRAIL_PRIVATE_KEY": "0xYOUR_PRIVATE_KEY"   // chain defaults to base, token to USDC
}
```

The value is read once, mapped to the chain's wallet shape, and **never logged**. The startup
banner names which env var supplied it (`PIPRAIL_PRIVATE_KEY` / `PIPRAIL_WALLET_KEY` /
`AGENT_KEY`) but never the value.

## Every variable

Each variable also accepts the shorter **alias** shown under its name.

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `PIPRAIL_PRIVATE_KEY`<br/><small>aka `PIPRAIL_WALLET_KEY` · `AGENT_KEY`</small> | only to **pay** | — | Wallet key/seed/mnemonic in the chain's native format (see below). **Omit it** to run read-only (discover/quote/register/budget/guide work; pay/plan need it). |
| `PIPRAIL_CHAIN`<br/><small>aka `CHAIN`</small> | no | `base` | EVM preset name or non-EVM family — one wallet on one chain. (Single-chain mode.) |
| `PIPRAIL_CHAINS` | no | — | **Multi-chain mode** — comma-separated chains (e.g. `base,polygon,solana`). Each takes its own `PIPRAIL_<CHAIN>_KEY` (+ optional `PIPRAIL_<CHAIN>_RPC_URL`); the server pays whichever chain a 402 asks for. Mutually exclusive with `PIPRAIL_CHAIN`/`PIPRAIL_PRIVATE_KEY`/`PIPRAIL_RPC_URL`. See [below](#pay-on-several-chains-from-one-server). |
| `PIPRAIL_MAX_AMOUNT`<br/><small>aka `MAX_AMOUNT`</small> | no | `0.10` | Ceiling **per payment**, human units. |
| `PIPRAIL_MAX_TOTAL`<br/><small>aka `MAX_TOTAL`</small> | no | `10.00` | Lifetime ceiling **per distinct token**, human units. |
| `PIPRAIL_MAX_TOTAL_DENOM` | no | (none) | Cross-token **grand total** per denomination, e.g. `USD:20.00,EUR:5.00` — sums every token of that unit, across every chain. See [Total budget](/spend-controls/total-budget/). |
| `PIPRAIL_MAX_PAYMENTS` | no | (none) | Lifetime cap on the **number** of settled payments, across every chain + token. |
| `PIPRAIL_MAX_PAYMENTS_PER_WINDOW` | no | (none) | Rolling-window cap on the **count** of payments. Needs `PIPRAIL_WINDOW_SECONDS`. |
| `PIPRAIL_TOKENS`<br/><small>aka `TOKENS`</small> | no | `USDC` *(USDT on any chain without native USDC — Tron, TON, Kaia)* | Comma-separated allowed token symbols, plus `native` for the chain's coin. |
| `PIPRAIL_SCHEMES` | no | `onchain-proof` | Comma-separated payment schemes (see below). |
| `PIPRAIL_HOSTS`<br/><small>aka `HOSTS`</small> | no | (any) | Comma-separated host allowlist — exact (`api.example.com`) or wildcard (`*.example.com`). |
| `PIPRAIL_RPC_URL`<br/><small>aka `RPC_URL`</small> | no | chain default | Override the RPC endpoint; fold any API key into the URL. |
| `PIPRAIL_ALLOW_UNKNOWN_TOKENS` | no | `false` | Pay tokens the SDK can't price? Keep `false`. |
| `PIPRAIL_TTL` | no | (none) | Session deadline in seconds — terminal once past. |
| `PIPRAIL_WINDOW_TOTAL` | no | (none) | Rolling-window budget, human units. Needs `PIPRAIL_WINDOW_SECONDS`. |
| `PIPRAIL_WINDOW_SECONDS` | no | (none) | Rolling-window width in seconds — pairs with `PIPRAIL_WINDOW_TOTAL` and/or `PIPRAIL_MAX_PAYMENTS_PER_WINDOW`. |
| `PIPRAIL_WARN_AT_FRACTION` | no | (none) | Emit a `budget-threshold` event the first time spend crosses this fraction `(0,1]` of any cap. |
| `PIPRAIL_SPEND_LOG` | no | (none) | Path to a JSONL [spend store](/spend-controls/persistence/) — the budget survives a restart. |
| `PIPRAIL_EVENT_LOG` | no | (none) | `stderr` or a file path — one-line-JSON sink for payment + budget events. |
| `PIPRAIL_CONFIRM` | no | `false` | Mode B — ask the human to approve each payment via elicitation. |
| `PIPRAIL_CONFIRM_TIMEOUT_MS` | no | `55000` | Approval window in ms; keep below your client's request timeout (≈60000). |
| `PIPRAIL_GUIDE` | no | `true` | Expose the agent-guide prompt + the guide/budget resources. |
| `PIPRAIL_NEAR_ACCOUNT_ID`<br/><small>aka `NEAR_ACCOUNT_ID`</small> | only on NEAR | — | Your NEAR account id (e.g. `you.near`). |

Boolean knobs (`PIPRAIL_ALLOW_UNKNOWN_TOKENS`, `PIPRAIL_CONFIRM`, `PIPRAIL_GUIDE`) accept
`1`, `true`, or `yes` (case-insensitive) as true; anything else is false.

## Pay on several chains from one server

Set `PIPRAIL_CHAINS` to a comma-separated list and give each chain its own key — the server
then pays whichever chain a 402 asks for, from **one process, under one shared budget**:

```jsonc
"env": {
  "PIPRAIL_CHAINS": "base,polygon,solana",
  "PIPRAIL_BASE_KEY": "0xYOUR_EVM_KEY",        // one EVM key works on every EVM chain
  "PIPRAIL_POLYGON_KEY": "0xYOUR_EVM_KEY",
  "PIPRAIL_SOLANA_KEY": "YOUR_BASE58_SECRET",  // needs the Solana peer libs (see Chains)
  "PIPRAIL_MAX_AMOUNT": "1.00"
}
```

- **Per-chain key:** `PIPRAIL_<CHAIN>_KEY` in that chain's native format (uppercase the chain;
  a hyphen becomes `_`). A chain with **no key is read-only** — it can plan/quote, not pay.
- **Per-chain RPC:** `PIPRAIL_<CHAIN>_RPC_URL` (optional, per chain).
- **NEAR** still uses the single `PIPRAIL_NEAR_ACCOUNT_ID`.
- **Shared budget:** `PIPRAIL_MAX_AMOUNT` / `PIPRAIL_MAX_TOTAL` / `PIPRAIL_TOKENS` (defaults to the
  **union** of each chain's stablecoin) apply to every chain; each chain keeps its own per-token
  ledger (no cross-token sum).
- **One mode at a time:** mixing `PIPRAIL_CHAINS` with the single-chain `PIPRAIL_CHAIN` /
  `PIPRAIL_PRIVATE_KEY` / `PIPRAIL_RPC_URL` is rejected at startup.

The tools, budget, and guide are identical to single-chain mode — `piprail_pay_request` just
gains the ability to route across your funded chains. It pays the **first chain you list** that
can settle the 402 (your preference order — there's no oracle to compare gas across different
coins); within a chain it picks the cheapest-gas rail. List your preferred chain first.

## The budget — the spend policy

`PIPRAIL_MAX_AMOUNT`, `PIPRAIL_MAX_TOTAL`, `PIPRAIL_TOKENS`, and `PIPRAIL_HOSTS` become the
SDK's [spend policy](/spend-controls/payment-policy/) — enforced **before any on-chain send**.
The model cannot exceed it even if it tries.

```jsonc
"env": {
  "PIPRAIL_PRIVATE_KEY": "0xYOUR_PRIVATE_KEY",
  "PIPRAIL_MAX_AMOUNT": "0.25",      // per payment, in the TOKEN's units
  "PIPRAIL_MAX_TOTAL": "5.00",       // lifetime, per (chain, token)
  "PIPRAIL_TOKENS": "USDC,native",   // USDC or the chain's coin
  "PIPRAIL_HOSTS": "*.example.com"   // only this domain
}
```

> The caps are in the **paid token's units** — so `0.25` is ~25¢ for USDC, but with `native`
> allowed it's `0.25` of the chain's coin (e.g. 0.25 ETH ≈ \$1000s), since there's no price
> oracle. Keep `PIPRAIL_TOKENS` to ≈\$1 stablecoins if you want the cap to read as dollars.

`PIPRAIL_TOKENS` takes token **symbols** (`USDC`, `USDT`, `EURC`, …) plus the chain-agnostic
alias **`native`** — the chain's own coin (ETH on Base, TRX on Tron, XLM on Stellar) without
naming the ticker. The default is data-driven — it tracks what actually exists on the chain: USDC
where it exists, else **USDT on any chain without native USDC** (Tron, TON, and the Kaia EVM preset),
so a USDC-only policy would never silently block every payment. See [Chains](/mcp/chains/) for the full per-chain token story.

## The grand total and the count caps

`PIPRAIL_MAX_TOTAL` is per **distinct token** — across several stablecoins (or several chains) that
silently multiplies. For one number across everything, set `PIPRAIL_MAX_TOTAL_DENOM`: a
comma-separated list of `UNIT:AMOUNT` pairs that sums the **human value** of every token of that
unit. See [Total budget](/spend-controls/total-budget/).

```jsonc
"env": {
  "PIPRAIL_PRIVATE_KEY": "0xYOUR_PRIVATE_KEY",
  "PIPRAIL_MAX_TOTAL_DENOM": "USD:20.00,EUR:5.00",  // $20 across ALL USD stablecoins, €5 across EURC
  "PIPRAIL_MAX_PAYMENTS": "100",                     // …and at most 100 payments, ever
  "PIPRAIL_MAX_PAYMENTS_PER_WINDOW": "10",           // …at most 10 within the rolling window
  "PIPRAIL_WINDOW_SECONDS": "3600"
}
```

- **`PIPRAIL_MAX_TOTAL_DENOM`** folds the built-in stablecoins (`USDC`, `USDT`, `USD1`, `FDUSD`,
  `U`, `RLUSD` → `USD`; `EURC` → `EUR`) into one unit-of-account total. It is **not a price oracle** — a
  token's unit is a static, ship-time label, summed 1:1; the chain's native coin and any unknown
  token have no denomination and are never summed. It coexists with `PIPRAIL_MAX_TOTAL`; the
  stricter cap wins.
- **`PIPRAIL_MAX_PAYMENTS`** caps the lifetime *number* of settled payments (counts need no oracle,
  so they span every chain and token, native included).
- **`PIPRAIL_MAX_PAYMENTS_PER_WINDOW`** is a count cap over the rolling window — it requires
  `PIPRAIL_WINDOW_SECONDS` (a count-only window is fine; it can share the same width as
  `PIPRAIL_WINDOW_TOTAL`).

:::note[Multi-chain shares one ledger]
In multi-chain mode (`PIPRAIL_CHAINS`) every chain's client shares **one ledger**, so the grand
total and the payment counts span **every funded chain** — `USD:20.00` means $20 total across base
*and* polygon *and* solana combined. (Per-token `PIPRAIL_MAX_TOTAL` still keeps its own ledger per
`(chain, token)`.)
:::

The `piprail_budget` tool and the `piprail://budget` resource report the grand total (`byDenom`), the
payment counts, and the active policy alongside the per-asset rows.

## The time envelope

On top of the money caps you can add a time leash — see [Time
envelope](/spend-controls/time-envelope/). `PIPRAIL_TTL` is a hard session deadline in seconds:
once past, every payment is refused (terminal — restart to reset). The rolling window
rate-limits spend over a sliding interval.

```jsonc
"env": {
  "PIPRAIL_TTL": "3600",            // whole session expires after 1 hour
  "PIPRAIL_WINDOW_TOTAL": "1.00",   // at most 1.00 per…
  "PIPRAIL_WINDOW_SECONDS": "60"    // …rolling 60-second window
}
```

:::caution
A window **width** needs a window **cap**, and vice versa. `PIPRAIL_WINDOW_SECONDS` must accompany
`PIPRAIL_WINDOW_TOTAL` and/or `PIPRAIL_MAX_PAYMENTS_PER_WINDOW` (either or both), and each of those
caps needs `PIPRAIL_WINDOW_SECONDS`. A lone `PIPRAIL_WINDOW_SECONDS` is a half-armed leash that
wouldn't bite, so the server refuses to start with only one.
:::

## Survive a restart

By default the budget is in-memory — the session *is* the process, so a restart zeroes the lifetime
caps. Point `PIPRAIL_SPEND_LOG` at a file and the ledger hydrates from it at startup and appends each
settled payment, so `PIPRAIL_MAX_TOTAL`, `PIPRAIL_MAX_TOTAL_DENOM`, and `PIPRAIL_MAX_PAYMENTS` resume
where they left off. It's a plain JSONL file you own — no backend, no database.

```jsonc
"env": {
  "PIPRAIL_PRIVATE_KEY": "0xYOUR_PRIVATE_KEY",
  "PIPRAIL_MAX_TOTAL_DENOM": "USD:20.00",
  "PIPRAIL_SPEND_LOG": "/data/piprail-spend.jsonl"
}
```

In multi-chain mode the one file backs the single shared ledger, so the whole cross-chain grand
total is durable. The time envelope (`PIPRAIL_TTL`) stays process-scoped on purpose. See
[Persistence](/spend-controls/persistence/).

## Watch the spend

Two opt-in knobs surface what the wallet is doing without changing what it pays:

```jsonc
"env": {
  "PIPRAIL_WARN_AT_FRACTION": "0.8",   // warn the first time spend crosses 80% of ANY cap
  "PIPRAIL_EVENT_LOG": "stderr"        // or a file path
}
```

- **`PIPRAIL_WARN_AT_FRACTION`** is a number in `(0,1]`. The first time spend crosses that fraction
  of *any* cap (per-token, grand-total, count, or window), the server emits a `budget-threshold`
  event — an early heads-up before a decline.
- **`PIPRAIL_EVENT_LOG`** writes those events, plus every payment and decline, as one JSON object per
  line. Use `stderr` to fold them into the server's log stream, or a path to keep a separate audit
  file.

## Schemes — opt-in `exact`

`PIPRAIL_SCHEMES` chooses which payment **schemes** the wallet will settle. Absent, it stays on
PipRail's backendless rail (`onchain-proof`) only — the zero-config default, where the wallet
broadcasts and pays gas. Add `exact` to **also** pay standard x402 servers **gasless** — the wallet
only **signs**, and the server (or a facilitator it chose, e.g. PayAI) broadcasts, so the wallet
spends **zero gas** on **EVM, Solana, Algorand, Aptos, and NEAR**. `exact` is **one** scheme; its on-chain *method* (EIP-3009
for USDC/EURC, Permit2 for other EVM ERC-20s, SVM for any Solana SPL token, or a fee-payer sponsored transfer on Algorand / Aptos) is **auto-selected** per
chain + token — you never name it. See the [whole model in 30 seconds](/making-payments/gasless-payments/#the-whole-model-in-30-seconds).

```jsonc
"env": {
  "PIPRAIL_CHAIN": "solana",                 // or an EVM chain like "base"
  "PIPRAIL_SCHEMES": "onchain-proof,exact"   // also pay standard x402 servers (EVM + Solana + Algorand + Aptos + NEAR)
}
```

Add `upto` to also pay **metered / variable-amount** x402 servers on EVM (Permit2): the wallet signs
a **maximum**, the server meters real usage and settles the **actual ≤ that max**. The budget is
debited against the MAX, so a payable plan means the ceiling fits your leash.

Valid values are `onchain-proof`, `exact`, and `upto`; an empty or unrecognized list is rejected. See
the [exact buyer rail](/making-payments/exact-buyer/) for what the standard scheme settles.

## Two modes — autonomous vs supervised

The wallet behaves the same in both; only the source of consent differs. See
[Modes](/mcp/modes/) for the full contract.

- **Mode A — headless (default).** The agent spends freely *inside* the budget and time
  envelope. The policy **is** the consent — no per-payment prompt.
- **Mode B — supervised (`PIPRAIL_CONFIRM=1`).** On a client that can elicit, the human is
  asked to approve each spend at the moment it happens. Decline, cancel, timeout, or a dropped
  transport all fail-safe to **not** paying. On a client that can't elicit, it silently
  degrades to Mode A.

```jsonc
"env": {
  "PIPRAIL_CONFIRM": "1",                  // ask before every payment
  "PIPRAIL_CONFIRM_TIMEOUT_MS": "45000"    // approval window
}
```

## Wallet key formats

`PIPRAIL_PRIVATE_KEY` holds your secret in the chosen chain's **native** form — the server
maps it to the right SDK wallet shape automatically. See [Wallets by
family](/making-payments/wallets-by-family/) for details.

| Chain(s) | Format |
| --- | --- |
| EVM (base, ethereum, …), Tron | private key — `0x…` 32-byte hex |
| Sui | private key — `suiprivkey1…` (bech32) |
| Aptos | private key — `ed25519-priv-0x…` (AIP-80) or raw `0x…` hex |
| Solana | secret key — base58 |
| TON | mnemonic — 24 words, space-separated |
| Algorand | mnemonic — 25 words, space-separated |
| Stellar | secret seed — `S…` |
| XRPL | seed — `s…` |
| NEAR | private key — `ed25519:…` **plus** `PIPRAIL_NEAR_ACCOUNT_ID` |

:::note
`chain: 'near'` is the one chain that needs a second var: `PIPRAIL_NEAR_ACCOUNT_ID` (your
`you.near`). It's required alongside a NEAR key — a read-only (key-less) NEAR server boots without it.
:::

## RPC and API keys

There is **no separate API-key field** — fold any key into `PIPRAIL_RPC_URL`. This is also how
you point a rate-limited chain at a real endpoint (TON's keyless public RPC, for instance,
stalls verification at ~1 req/s).

```jsonc
"env": {
  "PIPRAIL_CHAIN": "ton",
  "PIPRAIL_RPC_URL": "https://toncenter.com/api/v2/jsonRPC?api_key=YOUR_KEY"
}
```

See [Chains](/mcp/chains/) for the per-chain RPC and gas caveats.

## Unknown tokens

By default the wallet refuses any token the SDK can't price, because an unpriceable token can't
be checked against your caps. `PIPRAIL_ALLOW_UNKNOWN_TOKENS=true` lifts that guard — keep it
`false` unless you have a specific reason, since it weakens the budget boundary.

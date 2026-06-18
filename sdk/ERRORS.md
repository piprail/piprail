# PipRail error handling — the driver contract

> ### 📖 The user-facing error model lives at → **[docs.piprail.com/errors](https://docs.piprail.com/errors/error-model/)**
> If you're a *consumer* of the SDK — handling a `PipRailError`, reading a `VerifyErrorCode`, or
> debugging why a payment failed — read the docs. They're the source of truth for the error model.

This file is the **internal error & driver contract** — the normative rules every module (the
client, the server gate, the registry) and **every chain driver** follows so the user-facing model
above holds *by construction*. It's deliberately small and uniform: every family (EVM, Solana, TON,
Tron, NEAR, Sui, Stellar, XRPL, Aptos, Algorand, and any future one) maps errors the same way, so a
human, a merchant server, or an AI agent always gets a **typed, understandable** reason, never an
opaque chain-library blob.

> If you're adding a chain/family/token, the `add-chain-integration` skill points here.
> Follow §5 (the driver contract) verbatim and your module is consistent by construction.

---

## 1. Two channels, and only two

Every failure surfaces through exactly one of two chain-agnostic channels:

| | Channel | Shape | For |
|---|---|---|---|
| **1** | **THROWN** | a typed [`PipRailError`](src/errors.ts) subclass with a stable `.code` | config / flow / wallet / registry / affordability problems the caller acts on |
| **2** | **RETURNED** | `VerifyResult` `{ ok: false, error, detail }` where `error` is a `VerifyErrorCode` | the outcome of verifying an on-chain proof (server side) |

- **Thrown** errors are caught with `err instanceof PipRailError`, or branched on `err.code`
  (a stable `SCREAMING_SNAKE` string). They never leak a raw `viem`/`@solana`/`@ton`/
  `@stellar` error for a condition the SDK recognises.
- **Returned** `VerifyResult` is how a driver's `verify()` reports *why a proof was rejected*
  without throwing. The gate turns `{ ok: false, error, detail }` into a **conformant v2
  `PaymentRequired` re-challenge** — a full 402 body with `accepts[]` (so a standard x402 client
  can retry), the human reason in `error`, and the machine code in `extensions.piprail.{code,detail}`.
  The built-in `requirePayment` adapter emits it + the `PAYMENT-REQUIRED` header automatically; the
  client reads the structured reason and relays it to the agent. (The legacy
  [`toInvalidBody`](src/server.ts) `{ status: 'invalid', … }` helper is **deprecated** — it has no
  `accepts[]`, so a standard client can't retry; prefer the gate's `result.challenge`.)

Rule of thumb: **config/flow/wallet/registry/affordability → throw; proof-verification
outcome → return.** Replay (`tx_already_used`) is the one verify-style code emitted by the
*gate* (not a driver), because only the gate owns the used-proof set.

---

## 2. Channel 1 — thrown `PipRailError`

Base class [`PipRailError`](src/errors.ts) (abstract; `.name` = the subclass name; supports
`{ cause }`). All are exported from the package root.

| `.code` | Class | Thrown when | Thrown by |
|---|---|---|---|
| `WRONG_FAMILY` | `WrongFamilyError` | wallet / `payTo` / token given in another family's shape (or a malformed same-family shape) | every driver (`bindWallet`, `assertValidPayTo`, `resolveToken`) |
| `UNKNOWN_TOKEN` | `UnknownTokenError` | a built-in token symbol the chain doesn't ship (e.g. `token: 'DOGE'`) | every driver (`resolveToken`) |
| `INSUFFICIENT_FUNDS` | `InsufficientFundsError` | the **payer** can't cover the transfer (+ fees / reserve / its own trustline) | every driver (`send`) — see §6 |
| `RECIPIENT_NOT_READY` | `RecipientNotReadyError` | the **recipient** (`payTo`) isn't set up to receive on this chain — XRPL not activated (needs ≥1 XRP base reserve); Stellar account missing / no trustline; NEAR not `storage_deposit`-registered | Stellar / XRPL / NEAR drivers (`send`) — see §6.1 |
| `WRONG_CHAIN` | `WrongChainError` | a bring-your-own `walletClient` is on a different chain than configured | EVM wallet adapter; client pre-send guard |
| `WALLET_REQUIRED` | `WalletRequiredError` | a wallet-bound op (`fetch`/pay, `planPayment`, `discoverySigner`) was called on a **read-only** client built with no `wallet` | client |
| `CONFIRMATION_TIMEOUT` | `ConfirmationTimeoutError` | broadcast OK but the tx didn't confirm within the driver's window (re-check the ref) | every driver (`confirm`) |
| `PAYMENT_TIMEOUT` | `PaymentTimeoutError` | the **server** didn't respond within `retryTimeoutMs` *after* broadcast — **carries `.ref`** | client |
| `MAX_RETRIES_EXCEEDED` | `MaxRetriesExceededError` | server kept returning 402 after broadcast — **message embeds the last server `error — detail`, and carries `.ref`** | client |
| `PAYMENT_DECLINED` | `PaymentDeclinedError` | the client refused to pay BEFORE any send — over the spend `policy` (amount/total/chain/token/host), or an `onBeforePay` hook returned false / threw | client |
| `INVALID_ENVELOPE` | `InvalidEnvelopeError` | a 402 had no parseable x402 challenge | client |
| `NO_COMPATIBLE_ACCEPT` | `NoCompatibleAcceptError` | the challenge offered no `accepts[]` entry the client can pay on its network + enabled `schemes` (message names the enabled schemes) | client |
| `UNSUPPORTED_SCHEME` | `UnsupportedSchemeError` | asked to pay a scheme the bound family/asset/signer can't settle, with no fallback: `exact` on a family without a `payExact` driver (i.e. not EVM or Solana), a non-EIP-3009 token (native/plain ERC-20) on a proxy-less chain, or a contract / EIP-1271 / EIP-7702 signer | client / EVM + Solana `exact` (`payExact`) |
| `NON_REPLAYABLE_BODY` | `NonReplayableBodyError` | `init.body` isn't replayable (e.g. a one-shot stream) | client |
| `MISSING_DRIVER` | `MissingDriverError` | a family's **optional peer deps aren't installed** (the lazy `import()` failed) — message names the exact `npm install` and sets `{ cause }` | registry loaders |
| `UNSUPPORTED_NETWORK` | `UnsupportedNetworkError` | no driver for the family, or the driver's `resolve()` returned `null` (unrecognised `chain`) | registry |
| `SETTLEMENT_FAILED` | `SettlementError` | the standard `exact` rail: a payment was VALID (sig recovered, simulated) but **settlement failed server-side** — the merchant's relayer couldn't broadcast, or a Mode-B facilitator returned a transport/auth error. NOT the payer's fault (their authorization stays valid + unused), so the adapter returns **5xx**, never 402 | gate (`exact` rail) |

`MISSING_DRIVER` vs `UNSUPPORTED_NETWORK` is a deliberate split: *deps not installed* vs
*chain not supported*. Don't reuse one for the other.

---

## 3. Channel 2 — returned `VerifyErrorCode`

A closed `snake_case` union ([`x402.ts`](src/x402.ts)). A driver's `verify()` returns one of
these on `{ ok: false, error, detail }`. **The compiler enforces the set** — you can't invent
a code, and you must use the same code other drivers use for the same condition.

| code | meaning | transient? | who emits it |
|---|---|---|---|
| `tx_not_found` | proof tx not on chain yet (RPC lag) or a transient RPC read failed | **transient** | all drivers |
| `insufficient_confirmations` | mined, but `< minConfirmations` | **transient** | EVM (chains with a discrete confirmation count) |
| `tx_reverted` | the tx is on chain but failed / reverted | definitive | all |
| `no_meta` | the tx carries no metadata to inspect | definitive | Solana |
| `wrong_recipient` | paid, but not to `payTo` | definitive | EVM / Solana native path |
| `amount_too_low` | paid to `payTo`, but `< required` | definitive | all |
| `transfer_not_found` | no matching transfer (asset / amount / nonce) to `payTo` | definitive | all |
| `payment_expired` | older than `maxTimeoutSeconds` (replay window); on `exact`, an expired/not-yet-valid EIP-3009 authorization | definitive | all |
| `tx_already_used` | this proof was already redeemed (replay); on `exact`, an on-chain-consumed authorization nonce | definitive | the **gate** (+ EVM `exact` via `authorizationState`) |
| `signature_invalid` | `exact` rail: the EIP-712 authorization signature didn't recover to the payer | definitive | EVM `exact` |

**Family-specificity is structural, not drift.** Account-watch chains (TON, Stellar) scan the
merchant account and can't tell "wrong recipient" from "no payment", so both collapse to
`transfer_not_found`; `no_meta` is Solana-only; `insufficient_confirmations` needs a discrete
confirmation count (EVM). Likewise EVM/Solana digest verifiers report a short token payment as
`transfer_not_found` (no nonce binding to point at), while nonce-bound chains (TON/Stellar)
can say `amount_too_low`. All correct.

**`transient`/`definitive` are informational.** The built-in client retries **every** code up
to `maxPaymentRetries` with a short backoff (which absorbs RPC lag) — it does *not* branch on
the code. A consumer building a custom client may branch on it.

---

## 4. What the agent receives

- **Rejected proof →** a conformant `402` **re-challenge**: a full v2 `PaymentRequired` body with
  `accepts[]` (so a standard x402 client can retry), the reason in `error`, and the machine code in
  `extensions.piprail.{code,detail}`, plus the `PAYMENT-REQUIRED` header. The built-in
  `requirePayment` adapter emits `result.challenge` automatically; other adapters should do the same
  (NOT the deprecated bare [`toInvalidBody`](src/server.ts), which omits `accepts[]`).
- **`exact`-rail settlement failed server-side →** a `5xx` (a thrown `SettlementError`), never a 402:
  the payer's EIP-3009 authorization is still valid and its nonce unused, so re-presenting it once the
  merchant fixes their relayer/facilitator settles — re-paying would be wrong.
- **Client gave up →** `MaxRetriesExceededError` whose message embeds the last server
  `error — detail` (e.g. `… Last server rejection: amount_too_low — Paid 40000, required
  500000.`), and a `payment-failed` event carrying the same reason.
- **Client refused to pay →** `PaymentDeclinedError` thrown *before* any on-chain send — the
  quote exceeded the client's `policy` (amount/total/chain/token/host, or the session's **time
  envelope**), or an `onBeforePay` hook returned false. Nothing moved. It carries an optional typed
  `reasonCode` (`'POLICY' | 'BUDGET' | 'OUTSIDE_WINDOW' | 'SESSION_EXPIRED' | 'APPROVAL'`) so an agent
  branches on the cause — and recognises a **TERMINAL** `SESSION_EXPIRED` / `APPROVAL` it must not
  retry — without parsing the message. The session TTL (`SESSION_EXPIRED`) and rolling window
  (`OUTSIDE_WINDOW`) reuse this EXISTING `PaymentDeclinedError` (`.code` stays `'PAYMENT_DECLINED'`):
  **no new error class, no new `VerifyErrorCode`** — only the closed `PayBlocker` union gains `OUTSIDE_WINDOW`.
- **Config / flow / wallet problem →** a thrown `PipRailError` with a stable `.code`.

> **The agent toolkit funnels all of this.** The `piprail_pay_request` tool catches **every**
> `PipRailError` and returns a structured `{ ok:false, code, reason, explain, ref?, reasonCode?,
> declined? }` instead of letting it crash the agent loop — so a broadcast-but-unconfirmed
> `PAYMENT_TIMEOUT`/`MAX_RETRIES_EXCEEDED`/`CONFIRMATION_TIMEOUT` reaches the model with its `.ref` and
> the never-re-pay rule (via `explainDecline`). Only a genuine non-`PipRailError` bug rethrows.
> The pure renderers (`render.ts`) and `classifyChallenge` (`classify.ts`) are viem-free protocol-layer
> modules; `render.ts`'s VALUE import of `errors.ts` is allowed (errors.ts is chain-agnostic).

Observability hooks never change control flow: the gate wraps **`onPaid` (settled) and `onFailed`
(a rejected proof — the same `VerifyErrorCode` the buyer is sent)** in the same isolation, and the
client routes every event through a private `safeEmit()` that swallows handler throws — a logging bug
can't abort a payment. (`onFailed` fires only on an `invalid` verdict the gate actually receives — not
on a no-proof `challenge`, nor on a thrown transient/`SettlementError`, nor on a buyer-side failure
that never reaches a backendless gate.)

---

## 4.1. A broadcast proof is never discarded (no false-positive, no double-pay)

Once `send()` returns, the transaction is **on-chain** and funds may have moved. Two design
rules make a flaky RPC safe in both directions:

- **Verify fails closed (server).** If the gate's `verify()` RPC read fails, it returns
  `tx_not_found` → the gate replies **402 (locked)**, *never* `paid`. An RPC outage can never
  trick a merchant into unlocking without a real, on-chain-confirmed payment. And the gate
  **releases the replay claim** when verification fails, so the payer can re-submit the *same*
  proof once the RPC recovers — the proof is not burned.
- **Confirm-timeout keeps the proof (client).** If the broadcast succeeds but the client's own
  `confirm()` times out (a throttled RPC that 429s its status polls past the validity window
  while the tx in fact lands), the client does **not** throw it away. It emits
  `payment-unconfirmed` and submits the proof to the server anyway — deferring to the server's
  on-chain verify (the authority) with **more patient retries** — and it **never re-broadcasts**.
  If the server ultimately can't confirm, the client throws `MaxRetriesExceededError` /
  `PaymentTimeoutError` carrying **`.ref`** (the broadcast proof).

> **The recovery rule for agents:** on `MAX_RETRIES_EXCEEDED` / `PAYMENT_TIMEOUT`, read `.ref`
> and **re-verify or re-submit that proof — never re-pay.** A fresh payment would double-spend.
> The same proof stays redeemable until the server's `maxTimeoutSeconds` recency window elapses
> (default 600s).

---

## 5. The driver error contract (follow this verbatim)

Every `PaymentDriver` / `ResolvedNetwork` method has a fixed error behaviour:

| method | on error |
|---|---|
| `resolve(opts)` | recognise + bind, **or return `null`** (registry maps `null` → `UnsupportedNetworkError`). Never throw a raw chain error for unrecognised input. |
| `resolveToken(token)` | unknown built-in symbol → `UnknownTokenError`; a foreign-family object token → `WrongFamilyError` (call the shared [`rejectForeignToken(token, family, network)`](src/drivers/shared.ts)); a malformed own-family token → `WrongFamilyError`. |
| `assertValidPayTo(payTo)` | a non-family address → `WrongFamilyError`. |
| `bindWallet(wallet)` | a foreign / unusable wallet shape → `WrongFamilyError`. |
| `send(wallet, accept)` | wrap the broadcast; map **sender** affordability → `InsufficientFundsError` (§6) and **recipient** setup → `RecipientNotReadyError` (§6.1); **rethrow everything else unchanged** (never swallow). Every mapped throw carries `{ cause }` = the raw chain error. |
| `verify(ref, accept)` | **return** a `VerifyResult` with a canonical `VerifyErrorCode`. **Guard every RPC read** so a transient failure returns `tx_not_found` — `verify()` must not throw for an RPC hiccup. Re-derive the watched account from the trusted `accept`, never the client ref. |
| `exactDomain?(asset)` *(optional, EVM)* | **never throw for a non-EIP-3009 token** — return `null` (the gate raises a clear config error). May throw only on a hard RPC failure at gate setup. |
| `settleExactSelf?(input)` *(optional, EVM)* | **return** a `VerifyResult` for a CLIENT-fixable fault (`signature_invalid`/`wrong_recipient`/`amount_too_low`/`payment_expired`/`tx_already_used`/`tx_reverted` → 402); **throw `SettlementError`** when a valid+simulated payment fails to BROADCAST (relayer/RPC → 5xx). Re-derive every checked field from the trusted `accept`, never the client echo. |
| `confirm(ref, n)` | broadcast-but-not-confirmed / timeout → `ConfirmationTimeoutError`. |
| `estimateCost(accept, opts?)` | **never throw** — guard the RPC read and fall back to a `'heuristic'` constant; always return a valid `CostEstimate`. |
| `balanceOf(wallet, asset)` | **never throw** — RPC-read-only. A field whose read was unavailable (transient/rate-limit) returns `null`, NOT `0` (a false 0 reads as "broke"). For `asset==='native'`, `token === native`. |
| `recipientReady(payTo, asset)` | **never throw** — report the receive prerequisite: `{ ready:'n/a' }` (no prerequisite on this family/native), `{ ready:true }`, `{ ready:false, reason }` (a `RecipientReason`), or `{ ready:'unknown' }` on a transient read. `'n/a'` must be TRUTHFUL — never a stand-in for "didn't check". |

> **`planPayment` is a RETURN-channel feature.** The client's `planPayment`/`canAfford` compose
> `balanceOf` + `recipientReady` + `estimateCost` + the policy verdict into a `PaymentPlan` — and,
> like `verify()`, they **return** the outcome rather than throwing: a transient read becomes a rail
> in `state:'unknown'` (+ a warning), an unsettleable rail carries typed `blockers`, and a 402 with
> no rail on the client's chain is *explained* in the plan. The only throw is `InvalidEnvelopeError`
> on an unparseable challenge. (`fetch({ autoRoute:true })` is the one place a plan turns into a
> THROWN `PaymentDeclinedError` — refusing before any send when nothing is settleable.)

> **Discovery is read-style too — it reports, it doesn't throw.** `client.discover()` /
> `searchOpenIndexes()` read third-party OPEN indexes: an index that's down, slow, or shape-changed
> simply contributes nothing (→ `[]`), never an exception — one dead index can't sink the others.
> `client.register()` / `register402Index()` / `registerX402Scan()` return one `RegisterOutcome` per
> target — a step the chain can't satisfy (x402scan on a non-Base/Solana client, no `discoverySigner`,
> or an HTTP error) comes back `{ ok:false, detail }`, surfaced not swallowed. The pure emitters
> (`buildOpenApi` / `buildWellKnownX402` / `buildX402DnsTxt`) do no I/O and can't fail at runtime. The
> optional `discoverySigner(wallet)` is discovery-only (ownership proofs / SIWX) — it never signs a payment.

### 6. Affordability converges on one error, by two mechanisms

"Wallet can't pay" must always surface as **`InsufficientFundsError`** — but the *detection*
is per-chain, because each library exposes a different signal:

- **Message-regex drivers (Solana, TON):** `send()` does
  `catch (err) { throw toInsufficientFundsError(err) ?? err }`. The shared
  [`toInsufficientFundsError`](src/errors.ts) matches the common "can't afford it" messages and
  returns `null` on a miss (so the original error propagates unchanged — never swallowed).
- **Structured-error drivers (EVM, Stellar):** detect from typed data — EVM walks viem's
  `BaseError` chain for a nested `InsufficientFundsError`; Stellar reads Horizon
  `result_codes` (and treats an unfunded source account's `loadAccount` 404 as the same). Both
  then *also* fall through to `toInsufficientFundsError` as a message-level backstop, so the
  two paths can't drift in vocabulary.

Either way the caller sees one `InsufficientFundsError` with `.code === 'INSUFFICIENT_FUNDS'`.

### 6.1. Sender vs recipient: `INSUFFICIENT_FUNDS` vs `RECIPIENT_NOT_READY`

Many chains require the **recipient** to be provisioned before it can receive — a chain
*state* rule, not the payer's balance. These must NOT masquerade as affordability, because
the fix is the opposite (set up the *recipient*, not fund the *payer*). So `send()` maps them
to **`RecipientNotReadyError`** (`RECIPIENT_NOT_READY`), distinct from `InsufficientFundsError`:

| Chain | Raw signal | → mapped to | Because the recipient needs… |
|---|---|---|---|
| **XRPL** | `tecNO_DST*` | `RecipientNotReadyError` | activation — an account must hold ≥1 XRP (base reserve) to exist |
| **XRPL** | `tecNO_LINE*`, `tecPATH_DRY`, `tecDST_TAG_NEEDED`, `tecNO_AUTH` | `RecipientNotReadyError` | a trustline for the IOU / a DestinationTag / authorization |
| **XRPL** | `tecUNFUNDED*`, `terINSUF*`, `tecINSUFF*` | `InsufficientFundsError` | (sender side — fund the payer) |
| **Stellar** | `op_no_destination` | `RecipientNotReadyError` | the account to exist (created with ≥1 XLM reserve) |
| **Stellar** | `op_no_trust`, `op_line_full`, `op_not_authorized` | `RecipientNotReadyError` | a trustline for the asset (and authorization) |
| **Stellar** | `op_underfunded`, `op_src_no_trust`, `op_low_reserve` | `InsufficientFundsError` | (sender side) |
| **NEAR** | `… is not registered` (NEP-141 panic) | `RecipientNotReadyError` | `storage_deposit` (NEP-145, ~0.00125 NEAR) |

**Two rules for these messages:** (1) state the requirement and the fix in plain language so a
human or an AI agent can act on it, and **echo the raw chain code** in the message (e.g.
`(XRPL: tecNO_DST_INSUF_XRP)`); (2) preserve the untouched chain error on `.cause`. Clarity for
the reader, full raw detail for the debugger — both, always. Chains with no receive prerequisite
(EVM, Solana, Sui, Aptos, Tron, native TON/NEAR) never throw `RecipientNotReadyError`.

---

## 7. Registry / loader pattern

- EVM is registered eagerly (`viem` is the one hard peer dep). Every non-EVM family (Solana,
  TON, Tron, NEAR, Sui, Stellar, XRPL, Aptos, Algorand) mounts lazily via a single dynamic
  `import()` in [`drivers/index.ts`](src/drivers/index.ts) the first time its `chain` is
  named — no setup call.
- A failed lazy `import()` → `MissingDriverError` naming the exact `npm install` + `{ cause }`.
  The in-flight promise isn't cached on failure, so a later call can retry.
- No driver for the family, or `resolve()` → `null` → `UnsupportedNetworkError`.
- Add a family = one loader entry + a mirrored `drivers/<family>/` folder. Nothing else in the
  protocol layer changes.

---

## 8. Shared building blocks (don't reinvent per chain)

| Helper | Where | Purpose |
|---|---|---|
| `toInsufficientFundsError(err)` | [`errors.ts`](src/errors.ts) | message → `InsufficientFundsError \| null` (the affordability backstop) |
| `rejectForeignToken(token, family, network)` | [`drivers/shared.ts`](src/drivers/shared.ts) | uniform `WrongFamilyError` for a foreign-family object token (data-driven; a new family is auto-covered) |
| `toInvalidBody(result)` | [`server.ts`](src/server.ts) | the canonical 402 'invalid' JSON body for every framework adapter |
| `delay(ms)` | [`util/async.ts`](src/util/async.ts) | the one poll/confirm delay shared by all drivers |
| `safeEmit(event)` | client (private); the gate mirrors it with an inline try/catch around `onPaid` | observability hooks never abort the flow |

---

## 9. New-module error checklist

```
- [ ] verify() returns ONLY canonical VerifyErrorCode values (compiler-enforced); same code
      as other drivers for the same condition; every RPC read guarded → tx_not_found on failure.
- [ ] send() wraps the broadcast and maps affordability → InsufficientFundsError
      (toInsufficientFundsError for message-only chains; structured detection + that backstop otherwise).
- [ ] send() maps any RECIPIENT-side setup requirement (activation / trustline / account / storage)
      → RecipientNotReadyError, with a plain-language fix + the raw chain code echoed + { cause } (§6.1).
- [ ] confirm() → ConfirmationTimeoutError on broadcast-but-not-confirmed.
- [ ] resolveToken(): unknown symbol → UnknownTokenError; foreign token → rejectForeignToken(...).
- [ ] bindWallet() / assertValidPayTo() → WrongFamilyError for the wrong shape, message names the right one.
- [ ] loader entry throws MissingDriverError with the exact `npm install` + { cause }.
- [ ] No raw chain error escapes for a condition the SDK recognises; the rest rethrow unchanged.
```

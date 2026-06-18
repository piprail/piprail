# Payment system — both sides notified, every event saved

PipRail "just like a payment system should be": **both the merchant and the buyer are
notified on SUCCESS and on FAILURE**, and the merchant persists every outcome to its own
SQLite ledger.

PipRail itself is still **$0, no backend, no database, no fee** — it's the *rail*. The
merchant's notifications fire locally and **this app owns the `payments.db` ledger**. You'd
do the same with Postgres, a webhook, Slack, email — PipRail hands you the event, you decide
where it goes.

## The 402 loop

```
  Buyer (PipRailClient)                       Merchant (createPaymentGate + SQLite)
    │  GET /api/report                              │
    │ ─────────────────────────────────────────────►│  verify() → kind:'challenge'
    │ ◄──────────── 402 + payment-required ──────────│  (onFailed does NOT fire — no proof yet)
    │  pay 0.05 USDC → payTo, on Base                │
    │  GET /api/report + payment-signature           │
    │ ─────────────────────────────────────────────►│  verify() against own RPC →
    │                                                │   kind:'paid'    → onPaid  → INSERT payments     ✅
    │                                                │   kind:'invalid' → onFailed → INSERT failed       ⚠️
    │ ◄──────────── 200 + data (or 402 again) ───────│
```

## Who gets notified

| Outcome | Merchant sees | Buyer sees | Carries the same `code`? |
|---|---|---|---|
| **Success** | `onPaid(receipt)` → row in `payments` (`✅`) | `client.fetch()` returns **200** + a `payment-settled` event | — (a receipt: tx, payer, amount) |
| **Failure (proof rejected)** | `onFailed(failure)` → row in `failed_attempts` (`⚠️`) | `fetch()` **throws** a typed error **and** emits `payment-failed` | **Yes** — the same `VerifyErrorCode` |

`onFailed` is the exact mirror of `onPaid`. Its argument is **only** `{ code, detail, transient }`
— a rejection has no settlement, so there's no tx / amount / payer to report.

### The `transient` flag

`transient: true` (codes `tx_not_found` / `insufficient_confirmations`) means the proof may
simply not have reached the merchant's RPC node yet — the buyer's client **auto-retries**, and
you'll get `onPaid` if it then settles. **Alert on `!transient`** (wrong amount, expired,
replayed, bad signature, wrong recipient) to avoid false alarms on normal RPC lag. Either way,
*every* rejected attempt is recorded.

### The one honest limit

A backendless gate is **passive** — it only ever learns about a payment when a request reaches
it. So a failure that **never reaches the gate** is seen **only by the buyer**:

- the buyer **can't afford it** (`InsufficientFundsError`),
- a `policy` / `onBeforePay` **declines it** before any send (`PaymentDeclinedError`, code `BUDGET`/`POLICY`/`APPROVAL` — **zero funds move**), or
- the buyer **abandons** before paying.

Every rejection that **does** reach the gate fires `onFailed`. (This is the same trade-off
stated in the gate's own JSDoc and `../CONCEPTS.md`.)

## Run

```bash
npm install

# 1) Start the merchant (set your own wallet)
PAY_TO=0xYourWallet… npm start

# 2) In another terminal, run the buyer (a funded Base key: USDC + a little ETH for gas)
AGENT_KEY=0x… npm run buyer

# 3) See the merchant's ledger — every success AND every failure it saw
curl http://127.0.0.1:3000/ledger
```

Targets **Base + USDC**, 0.05 per call, straight to your `PAY_TO`. Verification is local against
your own RPC (set `RPC=` to override the public default).

## See a FAILURE (not just the happy path)

A failure has to *reach the gate* to fire `onFailed` (see the limit above). The two easy ways:

- **Replay** — run the buyer twice for the same challenge / re-submit a spent proof. The second
  attempt is rejected `tx_already_used` (`transient: false`) → a `failed_attempts` row, and the
  buyer gets the same `tx_already_used` code.
- **Wrong amount** — point the buyer at a gate asking for more than was paid → `amount_too_low`.

A **buyer-only** failure (never recorded by the merchant): lower the buyer's `policy.maxAmount`
below `0.05` — `fetch()` throws `PaymentDeclinedError` (`BUDGET`) **before any send**, the buyer's
`payment-failed` event fires, and the merchant's `/ledger` stays empty for that attempt — exactly
as the honest limit describes.

## Files

- **`merchant.mjs`** — an Express server. A `createPaymentGate` with the explicit `verify()`
  switch, `awaitOnPaid` (record-before-serve), and `onPaid`/`onFailed` → SQLite. Free `GET /ledger`
  dashboard; paid `GET /api/report`.
- **`buyer.mjs`** — a `PipRailClient` that auto-pays, with an `onEvent` stream and a `try/catch`
  on the typed error, plus a spend `policy` cap.

## Next

- [`../CONCEPTS.md`](../CONCEPTS.md) — "Both sides are notified" + the error model
- [`../express`](../express) · [`../agent`](../agent) — the gate and the client on their own
- [docs.piprail.com](https://docs.piprail.com) — every chain, custom tokens, webhooks, policy controls

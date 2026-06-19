# Why 402? — with vs without the handshake

> *"The payer signs and broadcasts their own transfer straight to your wallet. So why do we need x402 at all? Can't it be a simple transfer like it always has been?"*

Good question — and the honest answer is **you're right that it's just a transfer.** PipRail's payer *does* sign and broadcast their own transfer; there's no facilitator in the middle. x402 is the thin standard *around* that transfer (a challenge before, a proof + local verify after) that makes it **discoverable, bound to a request, and safe between parties who never coordinated.**

Two files here make it concrete:

| File | What it shows |
| --- | --- |
| [`without-402.mjs`](./without-402.mjs) | A runnable mock of "just send the money." Prints the three **verification** holes. `node examples/basics/why-402/without-402.mjs` |
| [`without-402-server.mjs`](./without-402-server.mjs) | The **backend you'd have to run** without 402 — listener, correlation/accounts, async notify. `node examples/basics/why-402/without-402-server.mjs` |
| [`with-402.mjs`](./with-402.mjs) | The same payment with the SDK (gate + client), commented at each point a hole is closed. |

(For a **live** end-to-end against a real chain, see [`../express`](../express) (merchant) + [`../agent`](../agent) (payer).)

---

## The handshake, plainly

```
  Agent                                   Your server (PipRail)
    │  GET /report                              │
    │ ─────────────────────────────────────────►│  requirePayment / createPaymentGate
    │ ◄──────────── 402 + payment-required ──────│  challenge: chain, token, amount,
    │                                            │  payTo, + a fresh single-use NONCE
    │  pay ONE transfer to payTo (own key)       │
    │ ───────────────────►  [the blockchain]     │
    │  GET /report + payment-signature           │
    │ ─────────────────────────────────────────►│  verify on your OWN RPC:
    │                                            │   • succeeded? • recent?
    │                                            │   • right amount/asset to payTo?
    │                                            │   • not already used (replay)?
    │                                            │   …re-derived from the server's OWN spec
    │ ◄──────────── 200 + data + payment-response│
```

If the response **isn't** a 402, the client returns it untouched and never pays ([`client.ts:601`](../../../sdk/src/client.ts#L601)). No 402 = no payment, and nothing to verify.

---

## The three holes a raw transfer leaves (run `without-402.mjs` to watch them)

1. **Discovery.** Nothing at the URL states the price/token/chain/address. The agent hardcodes it from docs — unsigned, no canonical truth, silently wrong if the merchant rotates the address.
2. **Replay.** A tx hash is permanent. Without a single-use set, the same proof unlocks again and again, for free.
3. **Correlation / collision.** Two agents send an identical `0.05 USDC`. The transfers are byte-for-byte interchangeable — the server can't prove which one paid which request.

x402 closes them with a **machine-readable challenge** (discovery), a **single-use set + recency window** (replay), and — on memo chains — a **per-request nonce written into the transfer** (binding).

---

## The operational asymmetry — who runs the backend? (run `without-402-server.mjs`)

This is the part people miss. With a **raw transfer**, your server has to *find out* a payment happened, figure out *who/what* it was for, grant access, and tell the payer — none of which a bare transfer gives you. So you end up running a payments backend:

```
WITHOUT (raw)                              WITH PipRail
─────────────────────────                  ─────────────────────────
1 transfer lands on-chain                  1 client pays + confirms (its own key)
2 a LISTENER detects it   ── WebSocket /    2 retries with the proof header — IN-BAND
   poll / Etherscan · Alchemy webhook       3 server: a targeted lookup · your own RPC
3 CORRELATE it to a request ── + accounts,  4 200 + data + receipt
   Postgres / Redis
4 grant access (async job)
5 NOTIFY the payer "you're in" ── poll /
   SSE / callback
```

**Why?** A bare transfer is *push* — you must watch the chain. Plain RPC has no "tell me about transfers to my address" (for ERC-20 that's `Transfer` logs you scan), so you reach for an **indexer/explorer/webhook** (Etherscan, Polygonscan, Alchemy, QuickNode). Then a transfer carries **no request id and no user id**, so you need a **correlation store + accounts** to answer "whose request was this?". And since the original HTTP request already returned (you can't block for on-chain confirmation), access is **asynchronous** — the payer must poll/await a callback.

PipRail is *pull*: the client **hands you the exact tx ref in the `payment-signature` header**, so `verify()` does **a targeted lookup on your own RPC** ([`evm/verify.ts:50`](../../../sdk/src/drivers/evm/verify.ts#L50)) and returns `paid | challenge | invalid` **synchronously, in the same request** — the proof is an HTTP header, and "you're in" is the same `200`. No listener, no indexer, no accounts, no async notify. *402 makes payment a property of an HTTP request — baked into the web, not a separate rail.*

| | Raw transfer | x402 (PipRail) |
| --- | :---: | :---: |
| Chain listener / socket | ❌ one running 24/7 | ✅ none — a lookup on demand |
| Third-party indexer/explorer | ⚠️ usually (Etherscan/Alchemy) | ✅ your own RPC only |
| Attribution (who/what paid) | ⚠️ reference + accounts DB | ✅ the nonce self-attributes |
| Access grant | ⚠️ async (poll/callback) | ✅ synchronous, same `200` |

**Be fair — when is the listener/push model genuinely fine or better?** Fire-and-forget donations; a payer that can't hold an HTTP connection; streaming/batch settlement; a merchant that already runs indexing; non-HTTP rails; human checkout. For **an autonomous agent paying an HTTP API** — PipRail's whole target — pull/in-band wins decisively: zero backend, serverless-friendly, one call.

---

## The honest scorecard

A careful raw build matches the on-chain security. The two things it **structurally cannot** reach without re-introducing a handshake are **dynamic pricing** and **interop**.

| Property | Raw transfer | x402 (PipRail) |
| --- | :---: | :---: |
| Machine-readable discovery | ⚠️ static, self-host | ✅ per-request, standard |
| Server-authoritative verify | ✅ if you copy `verify()` | ✅ re-derives from own spec |
| Replay resistance | ✅ same used-set + window | ✅ single-use + recency |
| Per-request binding | ⚠️ memo ok, digest fragile | ✅ nonce per challenge\* |
| **Dynamic per-request pricing** | ❌ **needs a handshake** | ✅ fresh challenge / call |
| **Open-standard interop** | ❌ **private dialect** | ✅ x402 v2 envelope |
| Signed / tamper-proof terms | ✅ but you build signing | ✅ challenge is the auth |
| Closed error vocabulary + receipt | ✅ reused verbatim | ✅ `VerifyErrorCode` + receipt |

\* **Honest caveat:** on **memo chains** (TON, Stellar, XRPL, NEAR, Algorand) the nonce is written *into* the transfer — a true per-request lock. On **EVM/Solana**, PipRail binds by `amount + recipient + single-use set + recency` — the same ceiling a careful DIY scheme reaches ([`evm/verify.ts`](../../../sdk/src/drivers/evm/verify.ts)). PipRail does **not** claim a stronger crypto primitive; its innovation is the **settlement scheme** (`onchain-proof`: pay first, prove with a tx ref, verify locally — no facilitator/backend/fee) on a **standard-conformant envelope** so any x402 client and index interoperate.

---

## So… is it possible without 402?

**You can skip the 402 status code — but not the handshake.** The literal `402` is just a carrier: PipRail's `verify()` switches on the *shape* of the proof, not the status code ([`server.ts`](../../../sdk/src/server.ts)), and `parseChallenge` even falls back to the JSON body ([`x402.ts`](../../../sdk/src/x402.ts)). You could ride the same exchange over a body field, a `/pay` endpoint, or gRPC and lose nothing.

What you **cannot** skip is a standardized challenge → proof → local-verify **handshake**. With a bare transfer you can reach most of the security (verify, replay, signed terms) *if you rebuild it yourself*. Two things stay structurally out of reach:

- **Dynamic per-request pricing** — a static doc serves one price per resource. To charge per request you must return a fresh per-request signed spec — a challenge by another name.
- **Open-standard interop** — a private proof-id-in-memo scheme is invisible to x402 indexes (402 Index, x402scan) and breaks every off-the-shelf x402 client. *The network is the asset; it's the one piece you can't build alone.*

**The moment you rebuild the handshake, a private one is strictly worse than the open standard PipRail already speaks.** Payment is a two-sided market — an agent that speaks x402 transacts with any x402 resource on earth with zero bespoke integration; a private dialect makes every counterparty a custom build. PipRail keeps the envelope x402-v2-conformant and innovates only at the **settlement layer** (pay-first, verify-local, no facilitator) — exactly where innovation is free of interop cost.

> A bare transfer is cash left on a restaurant table with no check — you're guessing the total, and nothing proves *this* cash settled *this* meal. x402 is the itemized check the kitchen hands you (exact amount, who to pay, a one-time table number) verified against the kitchen's own ticket — never your word. Reconstruct it yourself and you'll print the same check, just one no other restaurant accepts.

## Honest limitations (read before production)

PipRail reaches the true ceiling of merchant-local verification cleanly — but it doesn't exceed it. Know these edges:

1. **The replay set is in-memory + single-process by default.** A restart drops it, reopening the window for any unexpired proof (default `maxTimeoutSeconds` = **600s**) on digest chains. **Back it with persistent storage in production** via `isUsed`/`markUsed`.
2. **Multi-instance needs an atomic store.** `isUsed`/`markUsed` are separate calls; without Redis `SET NX` (or a DB unique constraint) two concurrent requests with the same proof can both pass. The SDK leaves this to you — wire it up.
3. **Digest-chain binding is scope-based, not cryptographic** (`amount + recipient + asset + single-use + recency`). Memo chains bind the nonce inside the transfer. Two-tier model — make it explicit for your chain.
4. **Tighten the recency window for high-value payments** (`maxTimeoutSeconds`, e.g. 60s). The used-set is the real same-window defense; the window is the fallback.
5. **No payment privacy on memo chains** — the nonce rides visibly in the public memo field.
6. **You trust your own RPC 100%.** A compromised node can lie about a tx. Inherent to the no-backend design — point at a node you control or a strong public endpoint.
7. **Durability:** the proof is marked used before `onPaid` returns. Persist the payment *inside* `onPaid` so a crash can't leave a proof spent but unrecorded.
8. **The client blocks + stays online.** Pull/in-band means the payer waits for confirmation and holds the request open through the retry leg (`confirmTimeoutMs`, default 30s) — fine for an agent, not for fire-and-forget. If the broadcast lands but the retry times out, the SDK hands back the ref to re-verify and never re-pays.
9. **Memo chains read a bounded window** (e.g. TON's last-24 `getTransactions`). A payment buried under heavy account traffic before verify runs could fall outside it — keep the verify prompt, or raise the window.

---

## Think we're wrong? Please try 🤝

We'd **genuinely** like to be challenged on this. If you can get x402's full behaviour — discovery, dynamic per-request pricing, and cross-merchant interop — out of a raw transfer **without** rebuilding the handshake, we want to see it: [**open an issue**](https://github.com/piprail/piprail/issues) and show us, and we'll happily update the comparison. Honest scrutiny only makes the case stronger — that's the whole point of shipping the runnable proof and our own limitations.

*(Slides: [`site/public/why-402/`](../../../site/public/why-402/) — also embedded in the [root README](../../../README.md#-why-402-and-not-just-a-raw-transfer). Slide 2 is the operational architecture.)*

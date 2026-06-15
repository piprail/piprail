/**
 * WITH 402 — the same payment, done with PipRail's handshake.
 *
 * This shows the REAL SDK shape (server gate + client). To run it live against a
 * chain you need a funded wallet + RPC — see ../express (merchant) and ../agent
 * (payer) for the runnable end-to-end. Here the focus is: how the handshake closes
 * the three holes from without-402.mjs.
 *
 *   GET /report ──► 402 + challenge (terms + nonce) ──► pay one transfer ──►
 *   retry w/ proof ──► verify on your own RPC ──► 200 + receipt
 */
import { createPaymentGate, toInvalidBody, PipRailClient } from '@piprail/sdk'

const payTo = '0xMerchant...' // your wallet — money lands here directly, no middleman

// =========================================================================
// MERCHANT SIDE — gate the route once. Framework-agnostic core; in Express
// you'd just drop in `requirePayment({ chain, token, amount, payTo })`.
// =========================================================================
const gate = createPaymentGate({ chain: 'base', token: 'USDC', amount: '0.05', payTo })

async function handleRequest(req, res) {
  // The proof (if any) rides in the `payment-signature` header.
  const sig = req.headers['payment-signature']
  const r = await gate.verify(sig)

  if (r.kind === 'challenge') {
    // [HOLE 1 CLOSED — discovery] No proof yet. Answer 402 with a machine-readable
    // challenge: chain, token, amount, payTo, and a FRESH single-use nonce. The
    // client needs nothing out of band — the terms come from whoever owns the URL.
    return res402(res, r.challenge)
  }

  if (r.kind === 'paid') {
    // verify() checked the tx against YOUR OWN RPC and re-derived every field from
    // the gate's OWN spec (amount/asset/payTo) — never the client's echo:
    //   [HOLE 2 CLOSED — replay]      the proof ref is reserved in a single-use set
    //                                 (+ recency window); a reused hash -> tx_already_used.
    //   [HOLE 3 CLOSED — correlation] on memo chains the nonce is written INTO the
    //                                 transfer and matched here, locking this payment
    //                                 to THIS challenge. A lying client can't redirect
    //                                 funds or underpay — the decision uses server state.
    return ok(res, { report: 'data...' }, r.receiptHeader)
  }

  // r.kind === 'invalid' — wrong amount / expired / replayed. Re-challenge with the reason.
  return res402(res, toInvalidBody(r))
}

// =========================================================================
// AGENT SIDE — pay any 402 URL in one line. No per-merchant grammar.
// =========================================================================
async function agentPays() {
  const client = new PipRailClient({
    chain: 'base',
    wallet: { key: process.env.AGENT_KEY },
    // optional guardrails enforced BEFORE any on-chain send:
    policy: { maxAmount: '0.10', maxTotal: '5.00', tokens: ['USDC'] },
  })

  // fetch() does the whole loop: GET -> reads the 402 -> (budgets) -> pays ONE
  // transfer to payTo with the agent's own key -> retries with the proof -> 200.
  // If the URL ISN'T gated (no 402), it just returns the response and never pays.
  const res = await client.fetch('https://api.example.com/report')
  return res.json()
}

// --- tiny HTTP helpers (your framework does this) ---
function res402(res, body) {
  res.statusCode = 402
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(body))
}
function ok(res, data, receiptHeader) {
  res.statusCode = 200
  if (receiptHeader) res.setHeader('payment-response', receiptHeader)
  res.end(JSON.stringify(data))
}

export { gate, handleRequest, agentPays }

/*
 * The difference vs without-402.mjs in one breath:
 *   • discovery   — the 402 carries the terms; any client pays any server.
 *   • binding     — a per-request nonce + a used-set tie the payment to the request.
 *   • authority   — the server verifies against its OWN spec + its OWN RPC.
 * Same on-chain transfer underneath. The handshake is the thin standard that makes
 * it discoverable, bound, and safe between parties that never coordinated.
 */

// PipRail as a payment system: notify BOTH sides on SUCCESS and FAILURE,
// and persist every event to SQLite — no backend, no fee, no PipRail database.
//
//   npm install && PAY_TO=0xYourWallet… npm start
//
//   curl http://127.0.0.1:3000/ledger        # → free "merchant dashboard" (every success + failure)
//   curl http://127.0.0.1:3000/api/report    # → 402 + payment challenge
//
// Point ../payment-system/buyer.mjs (a PipRailClient) at /api/report to see the
// full loop. Env: PORT (default 3000), PAY_TO (your wallet), RPC (optional Base RPC).
//
// This uses createPaymentGate (not requirePayment) so the explicit verify() switch
// is visible — but onPaid / onFailed work identically either way.

import express from 'express'
import Database from 'better-sqlite3'
import { createPaymentGate } from '@piprail/sdk'

const PORT = Number(process.env.PORT ?? 3000)
const PAY_TO = process.env.PAY_TO ?? '0xYourWallet…'
const ITEM = 'quarterly-report' // what this paid resource sells (just a label we log)

// ── The merchant's OWN ledger. PipRail holds no database; this app owns this file. ──
const db = new Database('payments.db')
db.pragma('journal_mode = WAL')
db.exec(`
  CREATE TABLE IF NOT EXISTS payments (
    tx       TEXT PRIMARY KEY,   -- the settled tx id = receipt.idempotencyKey (dedupe key)
    payer    TEXT,
    amount   TEXT,
    symbol   TEXT,
    item     TEXT,
    paid_at  INTEGER
  );
  CREATE TABLE IF NOT EXISTS failed_attempts (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    code      TEXT,               -- the SAME VerifyErrorCode the buyer is told
    detail    TEXT,
    transient INTEGER,            -- 1 = proof may still be settling (buyer auto-retries)
    item      TEXT,
    failed_at INTEGER
  );
`)

const recordPaid = db.prepare(
  'INSERT OR IGNORE INTO payments (tx, payer, amount, symbol, item, paid_at) VALUES (?, ?, ?, ?, ?, ?)'
)
const recordFailed = db.prepare(
  'INSERT INTO failed_attempts (code, detail, transient, item, failed_at) VALUES (?, ?, ?, ?, ?)'
)

// ── One gate. Both outcomes are notified AND persisted. ──
const gate = createPaymentGate({
  chain: 'base',
  token: 'USDC',
  amount: '0.05',
  payTo: PAY_TO,
  rpcUrl: process.env.RPC, // optional; omit to use a public Base RPC
  // Record the receipt BEFORE the goods are served (record-before-serve).
  awaitOnPaid: true,
  // ✅ SUCCESS — fires AFTER a verified settlement. at-least-once → INSERT OR IGNORE on the tx.
  onPaid: (r) => {
    recordPaid.run(r.idempotencyKey, r.payer, r.amountFormatted, r.symbol, ITEM, Date.now())
    console.log(`✅ paid ${r.amountFormatted} ${r.symbol} by ${r.payer.slice(0, 8)}… — tx ${r.transaction.slice(0, 10)}…`)
  },
  // ⚠️  FAILURE — the MIRROR of onPaid: fires when a SUBMITTED proof is REJECTED.
  // `failure` is EXACTLY { code, detail, transient } — a rejection has no settlement,
  // so there's no tx / amount / payer here. `transient` (tx_not_found /
  // insufficient_confirmations) means the proof may still be settling and the buyer's
  // client auto-retries — alert on !transient to avoid false alarms on RPC lag.
  onFailed: (f) => {
    recordFailed.run(f.code, f.detail, f.transient ? 1 : 0, ITEM, Date.now())
    console.log(`⚠️  rejected: ${f.code}${f.transient ? ' (transient — buyer retrying)' : ''} — ${f.detail}`)
  },
  // Both hooks are fully isolated — a throw routes here, it never breaks the request.
  onPaidError: (e) => console.error('onPaid hook threw (receipt NOT recorded):', e),
  onFailedError: (e) => console.error('onFailed hook threw (failure NOT recorded):', e),
})

const app = express()

// ── Paid route — 0.05 USDC on Base, straight to your wallet. ──
// The explicit verify() switch the gate gives you (requirePayment maps this for you).
app.get('/api/report', async (req, res) => {
  const result = await gate.verify(req.headers['payment-signature']) // the HEADER VALUE, not req

  switch (result.kind) {
    case 'paid':
      // Settlement verified + onPaid already recorded (awaitOnPaid). Serve the goods.
      res.setHeader('payment-response', result.receiptHeader)
      return res.json({ report: 'TOP SECRET — quarterly numbers', item: ITEM })

    case 'challenge': // no proof yet — the normal first request. onFailed does NOT fire here.
    case 'invalid': // a proof was submitted and REJECTED — onFailed already fired + recorded.
      res.setHeader('payment-required', result.requiredHeader)
      return res.status(result.statusCode).json(result.challenge)
  }
})

// ── Free "merchant dashboard": proof the merchant saw EVERY success AND failure. ──
app.get('/ledger', (_req, res) => {
  res.json({
    payments: db.prepare('SELECT * FROM payments ORDER BY paid_at DESC').all(),
    failed_attempts: db.prepare('SELECT * FROM failed_attempts ORDER BY failed_at DESC').all(),
  })
})

app.listen(PORT, () => {
  console.log(`http://127.0.0.1:${PORT}`)
  console.log(`  GET /api/report  → 0.05 USDC on Base → ${PAY_TO}`)
  console.log(`  GET /ledger      → free — every success + every failure this gate saw`)
  console.log(`\nLedger persists to ./payments.db (PipRail holds no database — this app owns it).`)
})

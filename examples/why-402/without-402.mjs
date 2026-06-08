/**
 * WITHOUT 402 — the "just send the money" approach, and exactly where it breaks.
 *
 * Run it:  node examples/why-402/without-402.mjs
 *
 * No SDK, no real chain — a tiny in-memory mock so the failures are reproducible
 * and obvious. The point isn't that on-chain verification is hard (it isn't); it's
 * everything AROUND the transfer that a bare "pay my wallet" scheme can't do.
 *
 * Honest scope: this mirrors a digest-chain (EVM/Solana) naive integration. The
 * on-chain amount/asset/recipient check below is genuinely fine. What's missing is
 * discovery, a per-request binding, replay defense, and any interop.
 */

// ----- a fake chain: an append-only log of transfers -----
const CHAIN = []
let txCounter = 0
function sendTransfer({ from, to, amount }) {
  const txHash = '0xtx' + ++txCounter
  CHAIN.push({ txHash, from, to, amount })
  return txHash
}
function getTx(txHash) {
  return CHAIN.find((t) => t.txHash === txHash) ?? null
}

const MERCHANT = '0xMerchant'
const PRICE = 0.05 // USDC

// ----- the naive merchant: "show me a tx hash that paid me" -----
// This is the BEST a no-handshake server can do on a digest chain.
function naiveUnlock(requestId, txHash) {
  const tx = getTx(txHash)
  if (!tx) return { ok: false, why: 'tx not found' }
  if (tx.to !== MERCHANT) return { ok: false, why: 'wrong recipient' }
  if (tx.amount < PRICE) return { ok: false, why: 'amount too low' }
  // It paid *something*. But which request? There's no marker. We just say yes.
  return { ok: true, unlocked: requestId, paidBy: tx.from, txHash }
}

console.log('=== WITHOUT 402 — three holes a raw transfer leaves ===\n')

// ---------------------------------------------------------------------------
// HOLE 1 — DISCOVERY. The agent had to learn the price + address out of band.
// Nothing at the resource tells it. Hardcode it, hope it's current, and if the
// merchant rotates MERCHANT you silently pay the wrong wallet forever.
// ---------------------------------------------------------------------------
const agentKnows = { merchant: '0xMerchant', price: 0.05 } // <-- copied from docs. Unsigned. No canonical truth.
console.log('[1] Discovery: the agent HARDCODED the merchant + price from docs:')
console.log('    ', agentKnows, '— no way to detect an address rotation.\n')

// ---------------------------------------------------------------------------
// HOLE 2 — REPLAY. A tx hash is permanent. Without a single-use set, the same
// proof unlocks again and again. (Adding a used-set fixes it — but now YOU own
// that mutable state... which is one of the pieces x402 already ships.)
// ---------------------------------------------------------------------------
const txA = sendTransfer({ from: '0xAgentA', to: MERCHANT, amount: 0.05 })
const first = naiveUnlock('req-1', txA)
const replay = naiveUnlock('req-2', txA) // same hash, different request — should fail, doesn't
console.log('[2] Replay: Agent A pays once, then reuses the SAME tx hash:')
console.log('     first use  ->', first.ok ? 'UNLOCKED' : 'denied')
console.log('     replay     ->', replay.ok ? 'UNLOCKED (free access!)  <-- BUG' : 'denied')
console.log('')

// ---------------------------------------------------------------------------
// HOLE 3 — CORRELATION / COLLISION. Two agents each send the identical amount.
// The transfers are byte-for-byte interchangeable. The server cannot prove which
// transfer paid which request — it just binds whichever tx it sees to whoever asks.
// ---------------------------------------------------------------------------
const txB = sendTransfer({ from: '0xAgentB', to: MERCHANT, amount: 0.05 })
const txC = sendTransfer({ from: '0xAgentC', to: MERCHANT, amount: 0.05 })
// Agent B paid with txB and asks for ITS request. But a buggy/malicious client
// can point at txC (Agent C's payment) instead — the server can't tell.
const bUsesCsPayment = naiveUnlock('req-B', txC)
console.log('[3] Collision: Agent B and Agent C each send an identical 0.05 USDC.')
console.log('     Agent B claims req-B using Agent C\'s tx ->',
  bUsesCsPayment.ok ? 'UNLOCKED (B got in on C\'s money!)  <-- BUG' : 'denied')
console.log('     The two payments are indistinguishable; there is no request<->payment link.\n')

console.log('=== To plug these holes you would add: ===')
console.log('  • a machine-readable "here are my terms" response   (a challenge)')
console.log('  • a per-request id the payment carries + echoes back (a nonce)')
console.log('  • a single-use set + recency window                  (replay defense)')
console.log('That list IS x402 — see with-402.mjs. Re-implement it yourself and it')
console.log('works, but non-interoperably: the next merchant needs a fresh integration.')

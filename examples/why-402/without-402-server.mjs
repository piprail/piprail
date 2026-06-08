/**
 * WITHOUT 402 — the BACKEND you'd have to run.
 *
 * without-402.mjs showed the VERIFICATION holes. This shows the OPERATIONAL ones:
 * if the payer just sends a raw transfer to your wallet, your server has to find out
 * about it, figure out WHO it was for, grant access, and tell them — none of which a
 * bare transfer gives you. This is a sketch (pseudo-infra) to make the cost concrete.
 *
 * The punchline: a raw transfer turns "charge for an API call" into running a
 * payments backend — a chain listener, a third-party indexer, a correlation/accounts
 * store, and an async notify channel. PipRail's verify() is ONE synchronous call.
 */

// ===========================================================================
// PROBLEM 1 — DETECTION. A bare transfer to your wallet doesn't ring a bell.
// Plain RPC has no "tell me about transfers to my address" — for ERC-20 that's
// Transfer logs you must scan. So you run ONE of these, forever:
// ===========================================================================
//   (a) a WebSocket subscription   — eth_subscribe(logs, {to: MERCHANT})
//   (b) a polling loop             — eth_getLogs every N seconds, track cursor
//   (c) a third-party webhook       — Alchemy Notify / QuickNode / a block explorer
// All of them mean a long-lived process, reconnect logic, reorg handling, and
// (b)/(c) a DEPENDENCY + API KEY on Etherscan / Polygonscan / Alchemy.
async function startChainListener(onIncoming) {
  // pseudo: in reality this is a socket you keep alive 24/7, or a paid webhook.
  // const sub = provider.on({ address: MERCHANT, topics: [TRANSFER] }, onIncoming)
  // …handle: disconnects, missed blocks on restart, chain reorgs, duplicate events.
  console.log('[listener] watching MERCHANT for incoming transfers (forever)…')
}

// ===========================================================================
// PROBLEM 2 — ATTRIBUTION. A transfer carries no request id and no user id.
// "0xAgent sent 0.05 USDC" — for WHICH of your pending requests? For WHICH user?
// To answer, you must have issued the payer a reference up front (a memo/nonce —
// i.e. you just re-invented the 402 challenge) AND map their wallet to an account.
// So you need a correlation store + an accounts/auth system you didn't want.
// ===========================================================================
const pendingByRef = new Map() // ref -> { user, resource, price }  (you must mint + hand out `ref`)
const accountByWallet = new Map() // wallet -> userId               (a signup/auth flow)
const accessGranted = new Map() // userId -> Set(resource)

function onIncomingTransfer(tx) {
  // tx = { from, to, amount, memo? }
  // Best case: the payer included your ref in the memo — but you had to issue it
  // (a challenge) and many tokens/chains have no memo field, so this often fails.
  const ref = tx.memo
  const pending = ref ? pendingByRef.get(ref) : null
  if (!pending) {
    // No ref → fall back to guessing by wallet+amount. Ambiguous: two users paying
    // the same price are indistinguishable. (See without-402.mjs, hole #3.)
    console.log('[attribute] transfer with no usable ref — which request was this?!')
    return
  }
  // PROBLEM 3 — GRANT. Verify the tx is real/final (your own RPC read — fine), then
  // grant. But the user's ORIGINAL http request already returned seconds ago…
  accessGranted.set(pending.user, (accessGranted.get(pending.user) ?? new Set()).add(pending.resource))
  // PROBLEM 4 — NOTIFY. …so you must reach back out to tell them "you're in":
  //   • they POLL you ("am I in yet?")   — extra requests, latency
  //   • or you hold a WebSocket / SSE open per pending payer
  //   • or you fire a callback URL they registered
  notifyPayer(pending.user, pending.resource)
}
function notifyPayer(user, resource) {
  console.log(`[notify] async: telling ${user} they finally have access to ${resource}`)
}

// ===========================================================================
// And the gated endpoint can't answer synchronously — payment is a separate,
// out-of-band, eventually-consistent system bolted onto your API:
// ===========================================================================
function handleRequest(req, res) {
  const userId = accountByWallet.get(req.wallet) // needs the accounts system
  if (accessGranted.get(userId)?.has(req.resource)) return res.end('data...')
  // Not paid yet. Mint a ref, stash it, and tell the client to pay + then COME BACK
  // (poll) — because you can't block here for on-chain confirmation.
  const ref = mintRef()
  pendingByRef.set(ref, { user: userId, resource: req.resource, price: 0.05 })
  res.statusCode = 402 // ← you even end up reaching for 402… just without the standard
  res.end(JSON.stringify({ payTo: 'MERCHANT', amount: 0.05, ref, note: 'pay then poll back' }))
}
function mintRef() { return 'ref-' + Math.random().toString(36).slice(2) }

startChainListener(onIncomingTransfer)

console.log(`
=== WITHOUT 402, the merchant must run a payments backend ===
  • a chain LISTENER (socket/poll) or a paid webhook        -> Etherscan / Alchemy / QuickNode
  • a CORRELATION store (ref -> request) + ACCOUNTS (wallet -> user)
  • an ASYNC GRANT + NOTIFY channel (poll / SSE / callback)
  • reorg + reconnect + missed-event + duplicate handling

=== WITH PipRail, the merchant runs ONE function ===
  const r = await gate.verify(req.headers['payment-signature'])
  // the client HANDS you the exact tx ref in-band; verify() does a targeted read on
  // YOUR OWN RPC and returns paid|challenge|invalid — synchronously, same request.
  // No listener. No indexer. No accounts. No async notify. (see with-402.mjs)
`)

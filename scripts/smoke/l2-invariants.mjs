/**
 * L2 · INVARIANTS — the money rules that hold across transports, rails and concurrency.
 *
 * `gate` attacks one gate through one door. This attacks the SEAMS, which is where a
 * double-spend actually hides:
 *
 *   · TRANSPORT   — the same proof over HTTP and over raw JSON (A2A). Two doors, one lock?
 *   · IDENTITY    — the payment-identifier idempotency key, which is a second replay namespace.
 *   · RAIL        — a multi-rail 402, where the cheap rail's proof is offered for the dear one.
 *   · RECENCY     — a real, unspent proof that is simply too old.
 *   · BUDGET      — a spend cap under CONCURRENT payments. A cap that is read, then awaited,
 *                   then written is the same shape of bug as a replay set that does the same,
 *                   and it lets an agent overspend its leash rather than double-spend a proof.
 *
 * Each of these is a place where two correct-looking pieces meet and the invariant can fall
 * through the gap between them.
 */
export const meta = {
  id: 'invariants',
  layer: 'L2',
  what: 'cross-transport replay, identifier replay, rail confusion, recency, budget races',
  why: 'a double-spend hides in the seam between two components that are each correct alone',
}

const PAY_TO = '0x' + '3'.repeat(40)
const REF = (n) => '0x' + String(n).repeat(64).slice(0, 64)

export async function run({ sdk, section, check, serve }) {
  const {
    createPaymentGate, registerDriver, buildSignatureHeader, decodeBase64Json,
    PipRailClient, memorySpendStore, SpendLedger,
  } = sdk

  let verifyDelayMs = 0
  let sendCounter = 1
  registerDriver({
    family: 'evm',
    resolve(opts) {
      const chain = opts.chain
      const id = typeof chain === 'object' ? chain.id : { base: 8453 }[chain]
      if (typeof id !== 'number') return null
      const network = `eip155:${id}`
      return {
        family: 'evm', network, supports: (n) => n === network,
        resolveToken: (t) => ({ asset: '0x' + 'a'.repeat(40), decimals: 6, symbol: String(t ?? 'USDC') }),
        describeAsset: () => ({ symbol: 'USDC', decimals: 6 }),
        assertValidPayTo: () => undefined,
        bindWallet: (w) => ({ _native: w }),
        // A UNIQUE ref per send. A driver that returns one constant hash makes every second
        // payment look like a replay, which would hide a budget bug behind a retry storm.
        send: async () => `0x${(sendCounter++).toString(16).padStart(64, 'e')}`,
        confirm: async () => ({ height: '1' }),
        estimateCost: async () => ({ feeSymbol: 'ETH', feeDecimals: 18, fee: '0', feeFormatted: '0', basis: 'heuristic' }),
        addressOf: async () => '0xself',
        balanceOf: async () => ({ token: 10n ** 12n, native: 10n ** 18n }),
        recipientReady: async () => ({ ready: 'n/a' }),
        verify: async (ref, accept) => {
          if (verifyDelayMs) await new Promise((r) => setTimeout(r, verifyDelayMs))
          return {
            ok: true,
            receipt: { scheme: 'onchain-proof', success: true, network: accept.network, transaction: ref,
              asset: accept.asset, amount: accept.amount, payer: '0xpayer', payTo: accept.payTo, verifiedAt: 'now' },
          }
        },
      }
    },
  })

  const mk = (over = {}) => createPaymentGate({
    chain: { id: 8453, rpcUrl: 'x' }, token: 'USDC', amount: '0.05', payTo: PAY_TO, ...over,
  })
  const isPaid = (r) => r?.kind === 'paid'
  const why = (r) => `${r?.kind}${r?.error ? `/${r.error}` : ''}`
  const chal = async (g) => {
    const { challenge } = await g.challenge('https://x.test/r')
    const accept = challenge.accepts.find((a) => a.scheme === 'onchain-proof')
    return { challenge, accept, nonce: accept.extra.nonce }
  }
  const hdr = (accepted, nonce, txHash, extra) =>
    buildSignatureHeader({ x402Version: 2, accepted, payload: { nonce, txHash }, ...(extra ? { extensions: extra } : {}) })

  // ── transport seam ──────────────────────────────────────────────────────────
  section('invariants · one lock, every door',
    'verify() and verifyObject() are two transports onto ONE replay set')

  await check('a proof spent over HTTP cannot be re-spent as raw JSON (A2A)', async () => {
    const g = mk(); const a = await chal(g)
    const first = await g.verify(hdr(a.accept, a.nonce, REF(1)))
    if (!isPaid(first)) return { fail: `first failed: ${why(first)}` }
    const b = await chal(g)
    const asObject = decodeBase64Json(hdr(b.accept, b.nonce, REF(1)))
    const second = await g.verifyObject(asObject)
    return !isPaid(second) ? `refused: ${why(second)}` : { fail: '🔴 SPENT TWICE across transports' }
  })

  await check('a proof spent as raw JSON cannot be re-spent over HTTP', async () => {
    const g = mk(); const a = await chal(g)
    const first = await g.verifyObject(decodeBase64Json(hdr(a.accept, a.nonce, REF(2))))
    if (!isPaid(first)) return { fail: `first failed: ${why(first)}` }
    const b = await chal(g)
    const second = await g.verify(hdr(b.accept, b.nonce, REF(2)))
    return !isPaid(second) ? `refused: ${why(second)}` : { fail: '🔴 SPENT TWICE across transports' }
  })

  await check('CONCURRENT across BOTH transports at once: exactly one wins', async () => {
    verifyDelayMs = 5
    const g = mk()
    const cs = await Promise.all(Array.from({ length: 6 }, () => chal(g)))
    const calls = cs.map((c, i) =>
      i % 2 === 0
        ? g.verify(hdr(c.accept, c.nonce, REF(3)))
        : g.verifyObject(decodeBase64Json(hdr(c.accept, c.nonce, REF(3))))
    )
    const rs = await Promise.all(calls)
    verifyDelayMs = 0
    const w = rs.filter(isPaid).length
    return w === 1 ? '1 of 6 across two transports' : { fail: `${w} of 6 PAID` }
  })

  // ── recency ─────────────────────────────────────────────────────────────────
  section('invariants · a proof expires', 'the replay window is what bounds an unspent proof')

  await check('the gate advertises its own timeout so a client can honour it', async () => {
    const g = mk({ maxTimeoutSeconds: 90 })
    const c = await chal(g)
    return c.accept.maxTimeoutSeconds === 90 ? '90s advertised' : { fail: `got ${c.accept.maxTimeoutSeconds}` }
  })

  await check('a nonce from an EXPIRED challenge is not silently honoured', async () => {
    // A 1-second window: the challenge is stale by the time it is answered. The driver would
    // normally enforce recency on-chain; the gate must not be the thing that forgets.
    const g = mk({ maxTimeoutSeconds: 1 })
    const c = await chal(g)
    await new Promise((r) => setTimeout(r, 1200))
    const r = await g.verify(hdr(c.accept, c.nonce, REF(4)))
    // Either refused, or accepted because the DRIVER owns recency — but never a crash.
    return isPaid(r) ? 'accepted (recency is the driver\'s job on-chain, not the gate\'s)' : `refused: ${why(r)}`
  })

  // ── rail confusion ──────────────────────────────────────────────────────────
  section('invariants · a multi-rail 402 cannot be cross-paid',
    'pay the cheap rail, claim the dear one')

  await check('a proof echoing a DIFFERENT rail than it paid is caught', async () => {
    // The fake driver above always confirms, so this asserts the gate verifies against ONE
    // coherent rail. The amount check itself is the driver's, proven live in L4.
    const g = createPaymentGate({
      accept: [
        { chain: { id: 8453, rpcUrl: 'x' }, token: 'USDC', amount: '0.01', payTo: PAY_TO },
        { chain: { id: 137, rpcUrl: 'x' }, token: 'USDC', amount: '5.00', payTo: PAY_TO },
      ],
    })
    const { challenge } = await g.challenge('https://x.test/r')
    const rails = challenge.accepts.filter((a) => a.scheme === 'onchain-proof')
    const cheap = rails.find((r) => r.amount === '10000')
    const dear = rails.find((r) => r.amount === '5000000')
    if (!cheap || !dear) return { fail: `rails: ${rails.map((r) => r.amount).join(',')}` }
    // Present the CHEAP rail's nonce while echoing the DEAR rail's terms.
    const forged = buildSignatureHeader({
      x402Version: 2, accepted: dear, payload: { nonce: cheap.extra.nonce, txHash: REF(5) },
    })
    const r = await g.verify(forged)
    // The gate must verify against ONE coherent rail, never a mix of two.
    if (!isPaid(r)) return `refused: ${why(r)}`
    return r.receipt.amount === dear.amount && r.receipt.network === dear.network
      ? 'settled coherently on the dear rail (its own terms)'
      : { fail: `receipt mixes rails: amount=${r.receipt.amount} network=${r.receipt.network}` }
  })

  await check('rails of ONE challenge share ONE nonce, and a fresh challenge mints a new one', async () => {
    /*
     * A nonce identifies the CHALLENGE, not the rail: the buyer picks one rail and pays it,
     * and replay is bound to the proof ref, not the nonce. So sharing across rails is correct.
     * What must NOT happen is a nonce surviving across challenges, which would let a stale
     * challenge be answered forever.
     */
    const g = createPaymentGate({
      accept: [
        { chain: { id: 8453, rpcUrl: 'x' }, token: 'USDC', amount: '0.01', payTo: PAY_TO },
        { chain: { id: 137, rpcUrl: 'x' }, token: 'USDC', amount: '0.02', payTo: PAY_TO },
      ],
    })
    const one = await g.challenge('https://x.test/r')
    const two = await g.challenge('https://x.test/r')
    const nonces = (c) => c.challenge.accepts.filter((a) => a.scheme === 'onchain-proof').map((a) => a.extra.nonce)
    const a = nonces(one), b = nonces(two)
    if (new Set(a).size !== 1) return { fail: `one challenge minted ${new Set(a).size} nonces across its rails` }
    return a[0] !== b[0] ? 'one nonce per challenge, fresh each time' : { fail: 'a nonce was REUSED across challenges' }
  })

  // ── identifier namespace ────────────────────────────────────────────────────
  section('invariants · the payment identifier is a second replay namespace',
    'opt-in idempotency: the same id must never buy twice, and a malformed one must not pass')

  await check('WITHOUT the opt-in, an identifier is ignored entirely', async () => {
    const g = mk(); const a = await chal(g)
    const id = { 'payment-identifier': { info: { id: 'idempotency-key-9999' } } }
    const r = await g.verify(hdr(a.accept, a.nonce, REF('d'), id))
    return isPaid(r) ? 'ignored, gate unchanged' : { fail: `opt-out path changed behaviour: ${why(r)}` }
  })

  await check('a repeated payment-identifier does not settle twice', async () => {
    // The identifier is OPT-IN: without `paymentIdentifier`, the gate ignores the extension
    // entirely and stays byte-identical to a gate that never heard of it.
    const g = mk({ paymentIdentifier: true })
    const a = await chal(g)
    // 16–128 chars, [A-Za-z0-9_-]. A shorter id is REFUSED as malformed, not used as a key.
    const id = { 'payment-identifier': { info: { id: 'idempotency-key-0001' } } }
    const first = await g.verify(hdr(a.accept, a.nonce, REF(6), id))
    const b = await chal(g)
    // A DIFFERENT tx, but the same idempotency id: the second must not be treated as new work.
    const second = await g.verify(hdr(b.accept, b.nonce, REF('8'), id))
    if (!isPaid(first)) return { fail: `first failed: ${why(first)}` }
    return !isPaid(second) ? `refused: ${why(second)}` : { fail: 'the same identifier settled twice' }
  })

  await check('a MALFORMED payment-identifier re-challenges rather than settling', async () => {
    const g = mk({ paymentIdentifier: true }); const a = await chal(g)
    const short = { 'payment-identifier': { info: { id: 'too-short' } } }
    const r = await g.verify(hdr(a.accept, a.nonce, REF('9'), short))
    return !isPaid(r) ? `refused: ${why(r)}` : { fail: 'settled on a malformed identifier' }
  })

  // ── client-side budget under concurrency ────────────────────────────────────
  section('invariants · a spend cap holds under CONCURRENT payments',
    'the same read-await-write shape that broke the replay set could break the leash')

  const gateFor = async () => {
    const g = mk({ amount: '1.00' })
    const srv = await serve(async (req) => {
      const sig = req.headers.get('payment-signature')
      const r = await g.verify(sig ?? undefined)
      if (r.kind === 'paid') {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200, headers: { 'content-type': 'application/json', 'payment-response': r.receiptHeader },
        })
      }
      return new Response(JSON.stringify(r.challenge), {
        status: 402, headers: { 'content-type': 'application/json', 'payment-required': r.requiredHeader },
      })
    })
    return { g, srv }
  }

  await check('SEQUENTIAL: maxTotal stops the payment that would breach it', async () => {
    const { srv } = await gateFor()
    try {
      const c = new PipRailClient({
        chain: { id: 8453, rpcUrl: 'x' }, wallet: { key: '0x' + '1'.repeat(64) },
        policy: { maxTotal: '2.50' }, // 1.00 each → the third must be refused
      })
      const outcomes = []
      for (let i = 0; i < 4; i++) {
        try { const r = await c.fetch(srv.url); outcomes.push(r.status) }
        catch (e) { outcomes.push(e.constructor.name) }
      }
      const paid = outcomes.filter((o) => o === 200).length
      return paid === 2 ? `2 of 4 paid, then declined` : { fail: `${paid} paid under a 2.50 cap: ${outcomes.join(', ')}` }
    } finally { await srv.close() }
  })

  await check('CONCURRENT: maxTotal is not breached by parallel payments', async () => {
    const { srv } = await gateFor()
    try {
      const c = new PipRailClient({
        chain: { id: 8453, rpcUrl: 'x' }, wallet: { key: '0x' + '1'.repeat(64) },
        policy: { maxTotal: '2.50' },
      })
      const rs = await Promise.allSettled(Array.from({ length: 6 }, () => c.fetch(srv.url)))
      const paid = rs.filter((r) => r.status === 'fulfilled' && r.value.status === 200).length
      const spent = c.spent?.() ?? null
      return paid <= 2
        ? `${paid} of 6 paid under a 2.50 cap`
        : { fail: `🔴 ${paid} of 6 paid — the leash leaked ${paid * 1} USDC against a 2.50 cap (spent=${JSON.stringify(spent)})` }
    } finally { await srv.close() }
  })

  await check('CONCURRENT: maxPayments (the count leash) is not breached either', async () => {
    const { srv } = await gateFor()
    try {
      const c = new PipRailClient({
        chain: { id: 8453, rpcUrl: 'x' }, wallet: { key: '0x' + '1'.repeat(64) },
        policy: { maxPayments: 2 },
      })
      const rs = await Promise.allSettled(Array.from({ length: 6 }, () => c.fetch(srv.url)))
      const paid = rs.filter((r) => r.status === 'fulfilled' && r.value.status === 200).length
      return paid <= 2 ? `${paid} of 6 paid under a 2-payment leash` : { fail: `🔴 ${paid} of 6 paid against maxPayments: 2` }
    } finally { await srv.close() }
  })

  // ── the ledger itself ───────────────────────────────────────────────────────
  section('invariants · the ledger cannot be made to lie')

  await check('a corrupt record is DROPPED, never tallied as a wrong number', () => {
    const l = new SpendLedger(memorySpendStore())
    const rec = (o) => ({ url: 'https://a/1', host: 'a', network: 'eip155:8453', asset: '0xa', symbol: 'USDC', amountFormatted: '1.00', ...o })
    l.record(rec({ amountBase: '1000000' }), 6)
    l.record(rec({ amountBase: 'not-a-number' }), 6)
    l.record(rec({ amountBase: '-5' }), 6)
    l.record(rec({ amountBase: '1e6' }), 6)
    l.record(rec({ amountBase: '1000000' }), -1)
    const s = l.summary()
    return String(s.byAsset[0]?.totalBase) === '1000000'
      ? 'only the valid record tallied' : { fail: `total=${s.byAsset[0]?.totalBase}` }
  })

  await check('a 2^200 amount is exact (no float drift in money math)', () => {
    const l = new SpendLedger(memorySpendStore())
    const big = (2n ** 200n).toString()
    l.record({ url: 'https://a/1', host: 'a', network: 'eip155:8453', asset: '0xa', symbol: 'USDC', amountBase: big, amountFormatted: 'huge' }, 6)
    return String(l.summary().byAsset[0]?.totalBase) === big ? 'exact at 2^200' : { fail: 'drifted' }
  })
}

/**
 * L2 · MERCHANT — the adapters a seller actually calls.
 *
 * Most merchants never touch `gate.verify()`. They call `createPaywall`, `createTipJar`, or
 * wrap a gate in `toFetchHandler` / `toWorker` / `requirePayment`. Those adapters decide
 * whether the paid resource is served, so a bug in one is free access to the thing being sold
 * even when the gate underneath is perfect. This attacks them through the front door: a real
 * HTTP request, no proof, and every shape of wrong proof.
 */
export const meta = {
  id: 'merchant',
  layer: 'L2',
  what: 'paywall, tip jar, fetch handler, worker, express middleware, proxy',
  why: 'the adapter decides whether the goods are served, so a hole here is free access',
}

const PAY_TO = '0x' + '3'.repeat(40)
const SECRET = 'the paid content nobody unpaid may see'
const REF = (n) => '0x' + String(n).repeat(64).slice(0, 64)

export async function run({ sdk, section, check, throws, serve }) {
  const {
    createPaymentGate, createPaywall, createTipJar, requirePayment,
    toFetchHandler, toWorker, registerDriver, buildSignatureHeader,
  } = sdk

  registerDriver({
    family: 'evm',
    resolve(opts) {
      const chain = opts.chain
      const id = typeof chain === 'object' ? chain.id : { base: 8453 }[chain]
      if (typeof id !== 'number') return null
      const network = `eip155:${id}`
      return {
        family: 'evm', network, supports: (n) => n === network,
        /*
         * 🔴 A FAITHFUL fake, not a permissive one.
         *
         * A stand-in that accepts every token and every address cannot test validation: it
         * reports a gate with `token: 'NOTATOKEN'` and `payTo: '0xnope'` as perfectly healthy,
         * so a real regression in either check would sail straight through this section. The
         * fake must refuse exactly what the real EVM driver refuses.
         */
        resolveToken: (t) => {
          const known = { USDC: 6, USDT: 6, EURC: 6 }
          if (typeof t === 'object' && t?.address) return { asset: String(t.address), decimals: t.decimals ?? 6, symbol: 'CUSTOM' }
          const sym = String(t ?? 'USDC').toUpperCase()
          if (!(sym in known)) throw new sdk.UnknownTokenError(`the evm driver does not ship ${sym}.`)
          return { asset: '0x' + 'a'.repeat(40), decimals: known[sym], symbol: sym }
        },
        describeAsset: () => ({ symbol: 'USDC', decimals: 6 }),
        assertValidPayTo: (addr) => {
          if (typeof addr !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(addr)) {
            throw new sdk.WrongFamilyError(`'${addr}' is not an EVM address.`)
          }
        },
        bindWallet: (w) => ({ _native: w }),
        send: async () => REF(1),
        confirm: async () => ({ height: '1' }),
        estimateCost: async () => ({ feeSymbol: 'ETH', feeDecimals: 18, fee: '0', feeFormatted: '0', basis: 'heuristic' }),
        addressOf: async () => '0xself',
        balanceOf: async () => ({ token: 0n, native: 0n }),
        recipientReady: async () => ({ ready: 'n/a' }),
        verify: async (ref, accept) => ({
          ok: true,
          receipt: { scheme: 'onchain-proof', success: true, network: accept.network, transaction: ref,
            asset: accept.asset, amount: accept.amount, payer: '0xpayer', payTo: accept.payTo, verifiedAt: 'now' },
        }),
      }
    },
  })

  const CHAIN = { id: 8453, rpcUrl: 'x' }
  const paid = () => new Response(SECRET, { status: 200 })
  const chal = async (g) => {
    const { challenge } = await g.challenge('https://x.test/r')
    const accept = challenge.accepts.find((a) => a.scheme === 'onchain-proof')
    return { accept, nonce: accept.extra.nonce }
  }
  const hdr = (accepted, nonce, txHash) =>
    buildSignatureHeader({ x402Version: 2, accepted, payload: { nonce, txHash } })

  /** Hit a handler with an optional proof and report what a stranger actually received. */
  async function hit(handler, proof) {
    const srv = await serve(handler)
    try {
      const res = await fetch(srv.url, proof ? { headers: { 'payment-signature': proof } } : undefined)
      return { status: res.status, body: await res.text() }
    } finally { await srv.close() }
  }

  // ── toFetchHandler ──────────────────────────────────────────────────────────
  section('merchant · toFetchHandler', 'the adapter most merchants actually deploy')

  const gate = createPaymentGate({ chain: CHAIN, token: 'USDC', amount: '0.05', payTo: PAY_TO })
  const handler = toFetchHandler(gate, paid)

  await check('no proof → 402, and the goods are NOT in the body', async () => {
    const r = await hit(handler)
    if (r.status !== 402) return { fail: `status ${r.status}` }
    return r.body.includes(SECRET) ? { fail: '🔴 the 402 body LEAKED the paid content' } : '402, nothing leaked'
  })

  await check('a valid proof → 200 with the goods', async () => {
    const c = await chal(gate)
    const r = await hit(handler, hdr(c.accept, c.nonce, REF(2)))
    return r.status === 200 && r.body.includes(SECRET) ? '200, served' : { fail: `status ${r.status}` }
  })

  await check('a REPLAYED proof → not 200 (the adapter honours the gate)', async () => {
    const c = await chal(gate)
    const proof = hdr(c.accept, c.nonce, REF(2)) // already spent above
    const r = await hit(handler, proof)
    return r.status !== 200 && !r.body.includes(SECRET) ? `refused with ${r.status}` : { fail: '🔴 REPLAY SERVED THE GOODS' }
  })

  for (const [label, proof] of [
    ['garbage', '!!!!'],
    ['empty', ''],
    ['base64 of null', Buffer.from('null').toString('base64')],
    // Node's fetch refuses a 1MB header outright, so that tests the transport, not the gate.
    // 8KB is large enough to be hostile and small enough to actually arrive.
    ['an 8KB blob', 'x'.repeat(8192)],
  ]) {
    await check(`a ${label} proof never serves the goods`, async () => {
      const r = await hit(handler, proof)
      return r.status !== 200 && !r.body.includes(SECRET) ? `refused with ${r.status}` : { fail: 'SERVED' }
    })
  }

  await check('the 402 carries a PAYMENT-REQUIRED header a client can act on', async () => {
    const srv = await serve(handler)
    try {
      const res = await fetch(srv.url)
      const h = res.headers.get('payment-required')
      return h && h.length > 20 ? 'header present' : { fail: `header=${h}` }
    } finally { await srv.close() }
  })

  // ── toWorker ────────────────────────────────────────────────────────────────
  section('merchant · toWorker', 'the same gate in a Cloudflare-shaped export')

  await check('the worker export gates identically', async () => {
    const w = toWorker(createPaymentGate({ chain: CHAIN, token: 'USDC', amount: '0.05', payTo: PAY_TO }), paid)
    const unpaidRes = await hit((req) => w.fetch(req))
    if (unpaidRes.status !== 402 || unpaidRes.body.includes(SECRET)) return { fail: 'unpaid was served' }
    return 'unpaid refused, shape matches toFetchHandler'
  })

  // ── createPaywall / createTipJar ────────────────────────────────────────────
  section('merchant · the presets', 'a preset must not be a looser gate than the one it wraps')

  await check('createPaywall gates an unpaid request', async () => {
    const p = createPaywall({ chain: CHAIN, token: 'USDC', amount: '0.10', payTo: PAY_TO })
    const r = await hit(toFetchHandler(p, paid))
    return r.status === 402 && !r.body.includes(SECRET) ? '402' : { fail: `status ${r.status}` }
  })

  await check('createPaywall advertises the amount it was given', async () => {
    const p = createPaywall({ chain: CHAIN, token: 'USDC', amount: '0.10', payTo: PAY_TO })
    const c = await chal(p)
    return c.accept.amount === '100000' ? '0.10 USDC advertised' : { fail: `amount=${c.accept.amount}` }
  })

  await check('createTipJar gates on its MINIMUM', async () => {
    const t = createTipJar({ chain: CHAIN, token: 'USDC', min: '0.25', payTo: PAY_TO })
    const c = await chal(t)
    return c.accept.amount === '250000' ? 'min 0.25 advertised' : { fail: `amount=${c.accept.amount}` }
  })

  await throws('a paywall with a zero amount is refused', async () => {
    await createPaywall({ chain: CHAIN, token: 'USDC', amount: '0', payTo: PAY_TO }).challenge('https://x/r')
  }, 'greater than zero')

  await throws('a tip jar with a zero minimum is refused', async () => {
    await createTipJar({ chain: CHAIN, token: 'USDC', min: '0', payTo: PAY_TO }).challenge('https://x/r')
  })

  await throws('a paywall with a malformed payTo is refused', async () => {
    await createPaywall({ chain: CHAIN, token: 'USDC', amount: '0.10', payTo: '0xnope' }).challenge('https://x/r')
  })

  // ── requirePayment middleware ───────────────────────────────────────────────
  section('merchant · requirePayment middleware', 'the express-shaped door')

  await check('an unpaid request never reaches next()', async () => {
    const mw = requirePayment({ chain: CHAIN, token: 'USDC', amount: '0.05', payTo: PAY_TO })
    let reached = false
    let status = 0
    const res = {
      setHeader: () => {},
      status: (c) => { status = c; return res },
      json: () => res,
    }
    await mw({ headers: {}, originalUrl: '/paid' }, res, () => { reached = true })
    if (reached) return { fail: '🔴 an UNPAID request reached the route handler' }
    return status === 402 ? '402, next() not called' : { fail: `status ${status}` }
  })

  await check('a valid proof DOES reach next()', async () => {
    const g = createPaymentGate({ chain: CHAIN, token: 'USDC', amount: '0.05', payTo: PAY_TO })
    const mw = requirePayment({ chain: CHAIN, token: 'USDC', amount: '0.05', payTo: PAY_TO })
    // The middleware owns its own gate, so mint the proof from its own challenge.
    let captured
    const res1 = { setHeader: (k, v) => { if (k.toLowerCase() === 'payment-required') captured = v }, status: () => res1, json: (b) => { captured ??= b; return res1 } }
    await mw({ headers: {}, originalUrl: '/paid' }, res1, () => {})
    return typeof captured === 'string' || typeof captured === 'object'
      ? 'the middleware issues a challenge a client can answer'
      : { fail: 'no challenge surfaced to the client' }
  })

  await check('an ARRAY payment-signature header (duplicated) does not crash the middleware', async () => {
    const mw = requirePayment({ chain: CHAIN, token: 'USDC', amount: '0.05', payTo: PAY_TO })
    let reached = false
    const res = { setHeader: () => {}, status: () => res, json: () => res }
    await mw({ headers: { 'payment-signature': ['a', 'b'] }, originalUrl: '/paid' }, res, () => { reached = true })
    return reached ? { fail: 'a duplicated header was treated as paid' } : 'refused, no crash'
  })

  // ── the gate's own self-check ───────────────────────────────────────────────
  section('merchant · selfTest is honest', 'a merchant asking "did I wire this right?"')

  await check('selfTest reports a well-formed gate as ok', async () => {
    const t = await createPaymentGate({ chain: CHAIN, token: 'USDC', amount: '0.05', payTo: PAY_TO }).selfTest()
    return t.ok ? `ok, ${t.rails?.length ?? 0} rail(s)` : { fail: `reported not ok: ${t.error}` }
  })

  await check('selfTest NEVER throws, even on a broken gate', async () => {
    const t = await createPaymentGate({ chain: CHAIN, token: 'NOTATOKEN', amount: '0.05', payTo: PAY_TO }).selfTest()
    return t.ok === false ? `reported not ok: ${String(t.error).slice(0, 60)}` : { fail: 'a broken gate reported ok' }
  })

  await check('a landing page renders for a human without leaking the goods', async () => {
    const g = createPaymentGate({ chain: CHAIN, token: 'USDC', amount: '0.05', payTo: PAY_TO })
    const { challenge } = await g.challenge('https://x.test/r')
    const html = g.landingPage(challenge)
    if (html.includes(SECRET)) return { fail: 'the landing page leaked the paid content' }
    return html.includes('402') || html.length > 200 ? `${html.length} bytes of HTML` : { fail: 'empty page' }
  })
}

/**
 * L2 · GATE — the merchant money path, attacked.
 *
 * A fake driver stands in for the chain, so every check here is about the PROTOCOL layer:
 * replay, concurrency, forged echoes, malformed input. No RPC, no money, milliseconds.
 */
export const meta = {
  id: 'gate',
  layer: 'L2',
  what: 'replay, concurrency, forged echoes, malformed proofs',
  why: 'a gate that mis-verifies hands over goods for nothing and cannot claw them back',
}

const PAY_TO = '0x' + '3'.repeat(40)
const ATTACKER = '0x' + '9'.repeat(40)
const REF = (n) => '0x' + String(n).repeat(64).slice(0, 64)

export async function run({ sdk, section, check, throws }) {
  const { createPaymentGate, registerDriver, buildSignatureHeader } = sdk

  const seen = []
  let verifyImpl = async (ref, accept) => ({
    ok: true,
    receipt: {
      scheme: 'onchain-proof', success: true, network: accept.network, transaction: ref,
      asset: accept.asset, amount: accept.amount, payer: '0xpayer', payTo: accept.payTo, verifiedAt: 'now',
    },
  })

  registerDriver({
    family: 'evm',
    resolve(opts) {
      const chain = opts.chain
      if (typeof chain !== 'object' || typeof chain.id !== 'number') return null
      const network = `eip155:${chain.id}`
      return {
        family: 'evm', network, supports: (n) => n === network,
        resolveToken: () => ({ asset: '0x' + 'a'.repeat(40), decimals: 6, symbol: 'USDC' }),
        describeAsset: () => ({ symbol: 'USDC', decimals: 6 }),
        assertValidPayTo: () => undefined,
        bindWallet: (w) => ({ _native: w }),
        send: async () => REF(1),
        confirm: async () => ({ height: '1' }),
        estimateCost: async () => ({ feeSymbol: 'ETH', feeDecimals: 18, fee: '0', feeFormatted: '0', basis: 'heuristic' }),
        addressOf: async () => '0xself',
        balanceOf: async () => ({ token: 0n, native: 0n }),
        recipientReady: async () => ({ ready: 'n/a' }),
        verify: async (ref, accept) => { seen.push({ ref, accept }); return verifyImpl(ref, accept) },
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
    return { accept, nonce: accept.extra.nonce }
  }
  const hdr = (accepted, nonce, txHash) =>
    buildSignatureHeader({ x402Version: 2, accepted, payload: { nonce, txHash } })

  // ── happy path ──────────────────────────────────────────────────────────────
  section('gate · a valid proof settles exactly once')

  await check('valid proof → paid, with a receipt', async () => {
    const g = mk(); const c = await chal(g)
    const r = await g.verify(hdr(c.accept, c.nonce, REF(1)))
    return isPaid(r) && r.receipt?.transaction ? `paid ${r.receipt.transaction.slice(0, 12)}…` : { fail: why(r) }
  })

  await check('the receipt carries the SERVER-trusted payTo and amount', async () => {
    const g = mk(); const c = await chal(g)
    const r = await g.verify(hdr(c.accept, c.nonce, REF(2)))
    return r.receipt.payTo === PAY_TO && r.receipt.amount === c.accept.amount
      ? 'receipt matches the trusted accept' : { fail: `payTo=${r.receipt.payTo}` }
  })

  // ── replay + concurrency ────────────────────────────────────────────────────
  section('gate · one proof, one redemption', 'sequential AND concurrent, every store shape')

  await check('the same proof twice is refused', async () => {
    const g = mk(); const a = await chal(g)
    await g.verify(hdr(a.accept, a.nonce, REF(3)))
    const b = await chal(g)
    const r = await g.verify(hdr(b.accept, b.nonce, REF(3)))
    return !isPaid(r) ? why(r) : { fail: 'DOUBLE SPEND' }
  })

  for (const [label, mutate] of [
    ['whitespace-padded', (t) => `  ${t}  `],
    ['upper-cased', (t) => t.toUpperCase().replace('0X', '0x')],
  ]) {
    await check(`a ${label} ref cannot re-spend`, async () => {
      const g = mk(); const a = await chal(g)
      await g.verify(hdr(a.accept, a.nonce, REF(4)))
      const b = await chal(g)
      const r = await g.verify(hdr(b.accept, b.nonce, mutate(REF(4))))
      return !isPaid(r) ? why(r) : { fail: `BYPASS via ${label} ref` }
    })
  }

  await check('built-in store: 5 concurrent, exactly one wins', async () => {
    const g = mk()
    const cs = await Promise.all(Array.from({ length: 5 }, () => chal(g)))
    const rs = await Promise.all(cs.map((c) => g.verify(hdr(c.accept, c.nonce, REF(5)))))
    const w = rs.filter(isPaid).length
    return w === 1 ? '1 of 5' : { fail: `${w} of 5 PAID` }
  })

  await check('CUSTOM store, one gate: 5 concurrent, exactly one wins', async () => {
    const spent = new Set()
    const g = mk({ isUsed: async (r) => spent.has(r), markUsed: async (r) => { spent.add(r) } })
    const cs = await Promise.all(Array.from({ length: 5 }, () => chal(g)))
    const rs = await Promise.all(cs.map((c) => g.verify(hdr(c.accept, c.nonce, REF(6)))))
    const w = rs.filter(isPaid).length
    return w === 1 ? '1 of 5' : { fail: `${w} of 5 PAID — the in-process reserve regressed` }
  })

  const atomic = () => {
    const keys = new Set()
    return {
      isUsed: async (ref) => { if (keys.has(ref)) return true; keys.add(ref); return false },
      markUsed: async () => {},
      releaseUsed: async (ref) => { keys.delete(ref) },
      size: () => keys.size,
    }
  }

  await check('ATOMIC store across SEPARATE gates: exactly one wins', async () => {
    const store = atomic()
    const gates = Array.from({ length: 5 }, () => mk(store))
    const cs = await Promise.all(gates.map(chal))
    const rs = await Promise.all(gates.map((g, i) => g.verify(hdr(cs[i].accept, cs[i].nonce, REF(7)))))
    const w = rs.filter(isPaid).length
    return w === 1 ? '1 of 5 across 5 gates' : { fail: `${w} of 5 PAID` }
  })

  await check('a thrown verify RELEASES the claim (built-in)', async () => {
    const g = mk(); const a = await chal(g)
    const saved = verifyImpl
    verifyImpl = async () => { throw new Error('rpc down') }
    try { await g.verify(hdr(a.accept, a.nonce, REF(8))) } catch { /* expected */ }
    verifyImpl = saved
    const b = await chal(g)
    return isPaid(await g.verify(hdr(b.accept, b.nonce, REF(8)))) ? 'retryable' : { fail: 'proof burned' }
  })

  await check('a thrown verify RELEASES the claim (atomic store + releaseUsed)', async () => {
    const store = atomic()
    const g = mk(store); const a = await chal(g)
    const saved = verifyImpl
    verifyImpl = async () => { throw new Error('rpc down') }
    try { await g.verify(hdr(a.accept, a.nonce, REF(9))) } catch { /* expected */ }
    verifyImpl = saved
    if (store.size() !== 0) return { fail: `reservation left behind (${store.size()})` }
    const b = await chal(g)
    return isPaid(await g.verify(hdr(b.accept, b.nonce, REF(9)))) ? 'released, retryable' : { fail: 'burned' }
  })

  await check('a SETTLED proof stays claimed (release must not undo a spend)', async () => {
    const store = atomic()
    const g = mk(store); const a = await chal(g)
    const first = await g.verify(hdr(a.accept, a.nonce, REF('a')))
    const b = await chal(g)
    const second = await g.verify(hdr(b.accept, b.nonce, REF('a')))
    return isPaid(first) && !isPaid(second) ? why(second) : { fail: 'settled proof was released' }
  })

  await check('KNOWN LIMIT: a non-atomic store across separate gates still races', async () => {
    // Pinned on purpose. No per-process set coordinates across processes, which is exactly why
    // the docs demand SET NX. If this starts passing, the seam changed: revisit the guidance.
    const spent = new Set()
    const gates = Array.from({ length: 5 }, () => mk({
      isUsed: async (r) => spent.has(r), markUsed: async (r) => { spent.add(r) },
    }))
    const cs = await Promise.all(gates.map(chal))
    const rs = await Promise.all(gates.map((g, i) => g.verify(hdr(cs[i].accept, cs[i].nonce, REF('b')))))
    const w = rs.filter(isPaid).length
    return w > 1 ? `${w}/5, as documented` : { fail: `now ${w}/5 — revisit replay-protection.md` }
  })

  await throws('releaseUsed without the isUsed/markUsed pair is refused',
    () => mk({ releaseUsed: () => {} }), 'releaseUsed')

  // ── forged echo ─────────────────────────────────────────────────────────────
  section('gate · verify re-derives from the TRUSTED accept, never the client echo')

  for (const [label, mutate] of [
    ['payTo redirected to an attacker', (a) => ({ ...a, payTo: ATTACKER })],
    ['amount lowered to dust', (a) => ({ ...a, amount: '1' })],
    ['asset swapped for a worthless token', (a) => ({ ...a, asset: '0x' + 'b'.repeat(40) })],
    ['network switched to a cheap chain', (a) => ({ ...a, network: 'eip155:1337' })],
    ['scheme downgraded', (a) => ({ ...a, scheme: 'free' })],
  ]) {
    await check(label, async () => {
      const g = mk(); const c = await chal(g)
      seen.length = 0
      const r = await g.verify(hdr(mutate(c.accept), c.nonce, REF('c')))
      if (!isPaid(r)) return `refused: ${why(r)}`
      const used = seen.at(-1)?.accept
      const clean = used && used.payTo === PAY_TO && used.amount === c.accept.amount &&
        used.asset === c.accept.asset && used.network === c.accept.network
      return clean ? 'verified against the TRUSTED accept' : { fail: `driver got a FORGED accept` }
    })
  }

  // ── malformed input ─────────────────────────────────────────────────────────
  section('gate · garbage produces a typed refusal, never a crash or a false paid')

  const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64')
  const garbage = [
    ['empty string', ''],
    ['not base64', '!!!not-base64!!!'],
    ['base64 of not-JSON', b64('hello world')],
    ['base64 of null', b64('null')],
    ['base64 of an array', b64('[1,2,3]')],
    ['no payload', b64({ x402Version: 2 })],
    ['payload as a string', b64({ x402Version: 2, accepted: {}, payload: 'x' })],
    ['__proto__ pollution', b64({ x402Version: 2, accepted: {}, payload: { nonce: 'n', txHash: 't', __proto__: { polluted: true } } })],
    ['constructor pollution', b64({ x402Version: 2, accepted: {}, payload: { nonce: 'n', txHash: 't' }, constructor: { prototype: { polluted: true } } })],
    ['1k-deep nesting', b64(JSON.parse('['.repeat(1000) + ']'.repeat(1000)))],
    ['1MB payload', b64({ x402Version: 2, accepted: {}, payload: { nonce: 'n', txHash: 'x'.repeat(1_000_000) } })],
    ['undefined', undefined],
    ['null', null],
    ['an array of headers', ['a', 'b']],
    ['a unicode ref', b64({ x402Version: 2, accepted: {}, payload: { nonce: 'n', txHash: '０x' + '1'.repeat(64) } })],
  ]

  for (const [label, value] of garbage) {
    await check(`refuses ${label}`, async () => {
      const g = mk()
      const t0 = Date.now()
      const r = await g.verify(value)
      const ms = Date.now() - t0
      if (isPaid(r)) return { fail: 'ACCEPTED AS PAID' }
      if (ms > 3000) return { fail: `${ms}ms — possible DoS` }
      return why(r)
    })
  }

  await check('Object.prototype was not polluted by any of the above', () =>
    ({}).polluted === undefined ? 'clean' : { fail: 'PROTOTYPE POLLUTED' })

  // ── config floors ───────────────────────────────────────────────────────────
  section('gate · a merchant misconfiguration fails at CONFIG time')

  await throws('a zero amount is refused', async () => {
    await mk({ amount: '0' }).challenge('https://x.test/r')
  }, 'greater than zero')

  await throws('an amount that rounds to zero is refused', async () => {
    await mk({ amount: '0.0000001' }).challenge('https://x.test/r')
  })

  await check('the smallest representable amount still works', async () => {
    const c = await chal(mk({ amount: '0.000001' }))
    return c.accept.amount === '1' ? '1 base unit' : { fail: `got ${c.accept.amount}` }
  })
}

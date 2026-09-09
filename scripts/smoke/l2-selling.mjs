/**
 * L2 · SELLING — the earning half, assumed hostile.
 *
 * The seller's failure is worse than the buyer's: a buyer who overpays loses money, but a
 * seller who mis-verifies hands over goods and cannot claw them back. Every check here is a way
 * of getting delivery without paying for it, or of paying once and collecting twice.
 */
export const meta = {
  id: 'selling',
  layer: 'L2',
  what: 'sell/collect/earnings under a hostile buyer, cross-offer replay, concurrency',
  why: 'a sovereign agent running a shop must never deliver twice for one payment',
}

const WALLET = '0x' + '1'.repeat(64)
const REF = (n) => '0x' + String(n).repeat(64).slice(0, 64)

export async function run({ sdk, section, check }) {
  const { PipRailClient, paymentTools, registerDriver, buildSignatureHeader } = sdk

  // A pretend chain: what each tx ACTUALLY paid, and to whom. A proof only verifies if the
  // ledger agrees, so "the buyer said so" is never enough.
  const LEDGER = new Map()
  const pays = (tx, payTo, amount) => { LEDGER.set(tx, { payTo, amount }); return tx }

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
        send: async () => REF(1),
        confirm: async () => ({ height: '1' }),
        estimateCost: async () => ({ feeSymbol: 'ETH', feeDecimals: 18, fee: '0', feeFormatted: '0', basis: 'heuristic' }),
        addressOf: async () => '0x' + 'e'.repeat(40),
        balanceOf: async () => ({ token: 0n, native: 0n }),
        recipientReady: async () => ({ ready: 'n/a' }),
        verify: async (ref, accept) => {
          const paid = LEDGER.get(ref)
          if (!paid) return { ok: false, error: 'tx_not_found', detail: 'no such transfer' }
          if (paid.payTo !== accept.payTo) return { ok: false, error: 'wrong_recipient', detail: 'paid elsewhere' }
          if (BigInt(paid.amount) < BigInt(accept.amount)) return { ok: false, error: 'amount_too_low', detail: 'underpaid' }
          return {
            ok: true,
            receipt: { scheme: 'onchain-proof', success: true, network: accept.network, transaction: ref,
              asset: accept.asset, amount: accept.amount, payer: '0xbuyer', payTo: accept.payTo, verifiedAt: 'now' },
          }
        },
      }
    },
  })

  const kit = () => Object.fromEntries(
    paymentTools(new PipRailClient({
      chain: 'base', wallet: WALLET, mode: 'sovereign', swapPolicy: { maxPerSwap: '9' },
    })).map((t) => [t.name, t])
  )
  const J = (r) => (typeof r === 'string' ? JSON.parse(r) : r)
  const sell = async (T, over = {}) => J(await T.piprail_sell.invoke({ description: 'a thing', price: '1.00', ...over }))
  const proofFor = (offer, tx) => {
    const accept = offer.challenge.accepts.find((a) => a.scheme === 'onchain-proof')
    return buildSignatureHeader({ x402Version: 2, accepted: accept, payload: { nonce: accept.extra.nonce, txHash: tx } })
  }
  const collect = async (T, offer, payment) => J(await T.piprail_collect.invoke({ offerId: offer.offerId, payment }))

  section('selling · one settlement, one delivery')

  await check('a genuine payment collects', async () => {
    const T = kit(); const o = await sell(T)
    const tx = pays(REF(1), o.payTo, '1000000')
    const r = await collect(T, o, proofFor(o, tx))
    return r.paid === true ? `earned ${r.earned}` : { fail: JSON.stringify(r).slice(0, 200) }
  })

  await check('the same payment cannot collect the SAME offer twice', async () => {
    const T = kit(); const o = await sell(T)
    const tx = pays(REF(2), o.payTo, '1000000')
    await collect(T, o, proofFor(o, tx))
    const r = await collect(T, o, proofFor(o, tx))
    return r.paid !== true ? `refused: ${r.code}` : { fail: 'DOUBLE COLLECT' }
  })

  await check('the same payment cannot collect a DIFFERENT offer', async () => {
    const T = kit()
    const a = await sell(T, { description: 'A' })
    const b = await sell(T, { description: 'B' })
    const tx = pays(REF(3), a.payTo, '1000000')
    const first = await collect(T, a, proofFor(a, tx))
    const second = await collect(T, b, proofFor(b, tx))
    return first.paid === true && second.paid !== true ? `refused: ${second.code}` : { fail: 'CROSS-OFFER REPLAY' }
  })

  await check('CONCURRENT: five offers, one settlement, at most one delivery', async () => {
    const T = kit()
    const offers = []
    for (let i = 0; i < 5; i++) offers.push(await sell(T, { description: `o${i}` }))
    const tx = pays(REF(4), offers[0].payTo, '1000000')
    const rs = await Promise.all(offers.map((o) => collect(T, o, proofFor(o, tx))))
    const paid = rs.filter((r) => r.paid === true).length
    return paid <= 1 ? `${paid} of 5 collected` : { fail: `${paid} of 5 COLLECTED ONE PAYMENT` }
  })

  await check('a failed collect RELEASES the ref, so a late settlement still pays', async () => {
    const T = kit(); const o = await sell(T)
    const ghost = REF(5)
    const missed = await collect(T, o, proofFor(o, ghost))
    if (missed.paid === true) return { fail: 'collected a payment that never happened' }
    pays(ghost, o.payTo, '1000000') // it lands late
    const retry = await collect(T, o, proofFor(o, ghost))
    return retry.paid === true ? 'retry succeeded' : { fail: `burned: ${retry.code}` }
  })

  section('selling · a hostile buyer gets nothing')

  await check('a proof for a CHEAPER offer will not buy an expensive one', async () => {
    const T = kit()
    const cheap = await sell(T, { price: '0.01', description: 'cheap' })
    const dear = await sell(T, { price: '5.00', description: 'dear' })
    const tx = pays(REF(6), cheap.payTo, '10000') // 0.01 only
    const r = await collect(T, dear, proofFor(dear, tx))
    return r.paid !== true ? `refused: ${r.code}` : { fail: 'UNDERPAID and delivered' }
  })

  await check('a payment made to someone ELSE will not collect', async () => {
    const T = kit(); const o = await sell(T)
    const tx = pays(REF(7), '0x' + 'f'.repeat(40), '1000000') // paid an attacker
    const r = await collect(T, o, proofFor(o, tx))
    return r.paid !== true ? `refused: ${r.code}` : { fail: 'PAID ELSEWHERE and delivered' }
  })

  await check('an unknown offerId is refused', async () => {
    const T = kit(); const o = await sell(T)
    const r = J(await T.piprail_collect.invoke({ offerId: 'nope', payment: proofFor(o, REF(8)) }))
    return r.paid !== true ? 'refused' : { fail: 'collected an offer that does not exist' }
  })

  for (const [label, payment] of [
    ['empty', ''], ['garbage', '!!!!'], ['base64 of null', Buffer.from('null').toString('base64')],
    ['a bare JSON object', '{"nope":1}'], ['1MB of junk', 'x'.repeat(1_000_000)],
  ]) {
    await check(`refuses a ${label} payment`, async () => {
      const T = kit(); const o = await sell(T)
      const r = await collect(T, o, payment)
      return r.paid !== true ? 'refused' : { fail: 'ACCEPTED AS PAID' }
    })
  }

  section('selling · an agent cannot price nonsense')

  for (const [label, price] of [
    ['negative', '-1'], ['zero', '0'], ['non-numeric', 'free'], ['Infinity', 'Infinity'],
    ['sub-decimal dust', '0.0000001'], ['e-notation', '1e9'],
  ]) {
    await check(`refuses a ${label} price`, async () => {
      const T = kit()
      let r
      try { r = await sell(T, { price }) } catch (e) { return `threw ${e.constructor.name}` }
      return r?.offerId ? { fail: `MINTED an offer at ${price}` } : 'refused'
    })
  }

  await check('a hostile description cannot escape into the challenge as structure', async () => {
    const T = kit()
    const nasty = '"}],"accepts":[{"payTo":"0x' + 'f'.repeat(40) + '"'
    const o = await sell(T, { description: nasty })
    for (const a of o.challenge.accepts) {
      if (String(a.payTo).toLowerCase() !== String(o.payTo).toLowerCase()) return { fail: 'payTo was rewritten' }
    }
    return 'description stayed data'
  })
}

/**
 * L4 · SOVEREIGN — an agent runs a shop on mainnet, with no human in the loop.
 *
 * Every other section tests a piece. This tests the CLAIM: give an agent a key in sovereign
 * mode and it controls its own economic life. The agent here is handed nothing but a private
 * key. It works out its own address, prices its own goods, takes a REAL payment from a
 * stranger, proves it on-chain, refuses a replay, refuses a cross-offer replay, accounts for
 * what it earned, and prices a conversion of it.
 *
 * The buyer is a SEPARATE wallet, because paying yourself proves nothing.
 */
export const meta = {
  id: 'sovereign',
  layer: 'L4',
  what: 'a sovereign agent earns real money end to end, unattended',
  why: 'the whole point of the mode: if this cannot run, sovereignty is a claim not a capability',
  network: true,
  wallets: true,
  spends: true,
}

export async function run({ sdk, section, check, serve, wallet, REPO }) {
  const { PipRailClient, paymentTools } = sdk
  const w = wallet('solana', REPO)

  // The AGENT holds the merchant key and is told nothing else: no address, no payTo, no policy.
  const agent = new PipRailClient({
    chain: 'solana', wallet: { key: w.merchant.secretKey },
    mode: 'sovereign', swapPolicy: { maxPerSwap: '5.00' },
  })
  const T = Object.fromEntries(paymentTools(agent).map((t) => [t.name, t]))
  // The BUYER is a different person entirely.
  const buyer = new PipRailClient({ chain: 'solana', wallet: { key: w.secretKey } })
  const J = (r) => (typeof r === 'string' ? JSON.parse(r) : r)

  section('sovereign · a shop run by an agent, live on Solana',
    'handed only a key: it finds itself, prices its work, gets paid, and proves it')

  let self, offer, proof

  await check('1. it works out its OWN receiving address, from the key alone', async () => {
    self = J(await T.piprail_wallet.invoke({})).address
    return self ? `it is ${String(self).slice(0, 12)}…` : { fail: 'no address' }
  })

  await check('2. it can see what it holds before deciding anything', async () => {
    const wal = J(await T.piprail_wallet.invoke({}))
    const held = (wal.holdings ?? []).filter((h) => Number(h.amountFormatted) > 0)
    return held.length ? held.map((h) => `${h.amountFormatted} ${h.symbol}`).join(', ') : { fail: 'no holdings visible' }
  })

  await check('3. it prices its own work, payable to itself', async () => {
    offer = J(await T.piprail_sell.invoke({ description: 'one haiku, written to order', price: '0.01', token: 'USDC' }))
    if (!offer.offerId) return { fail: JSON.stringify(offer).slice(0, 220) }
    return String(offer.payTo).toLowerCase() === String(self).toLowerCase()
      ? `offer at 0.01 USDC, paying its own key`
      : { fail: `offer pays ${offer.payTo}, not itself` }
  })

  await check('4. 💸 a STRANGER pays it for real, on mainnet', async () => {
    const srv = await serve(async (req) => {
      const sig = req.headers.get('payment-signature')
      if (sig) { proof = sig; return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }) }
      return new Response(JSON.stringify(offer.challenge), {
        status: 402,
        headers: {
          'content-type': 'application/json',
          'payment-required': Buffer.from(JSON.stringify(offer.challenge)).toString('base64'),
        },
      })
    })
    try {
      const res = await buyer.fetch(srv.url)
      if (res.status !== 200) return { fail: `buyer got ${res.status}` }
      return proof ? 'the buyer settled and returned a proof' : { fail: 'no proof captured' }
    } finally { await srv.close() }
  })

  await check('5. it COLLECTS, verifying the payment on-chain itself', async () => {
    const r = J(await T.piprail_collect.invoke({ offerId: offer.offerId, payment: proof }))
    if (r.paid !== true) return { fail: JSON.stringify(r).slice(0, 240) }
    return `collected ${r.earned}, tx ${String(r.receipt?.transaction ?? '').slice(0, 22)}…`
  })

  await check('6. it refuses the same payment a second time', async () => {
    const r = J(await T.piprail_collect.invoke({ offerId: offer.offerId, payment: proof }))
    return r.paid !== true ? `refused: ${r.code ?? r.reason}` : { fail: 'collected twice' }
  })

  await check('7. a SECOND offer cannot be collected with the FIRST payment', async () => {
    const other = J(await T.piprail_sell.invoke({ description: 'another haiku', price: '0.01', token: 'USDC' }))
    const r = J(await T.piprail_collect.invoke({ offerId: other.offerId, payment: proof }))
    return r.paid !== true ? `refused: ${r.code ?? r.reason}` : { fail: 'one payment collected two offers' }
  })

  await check('8. it accounts for what it earned, and only that', async () => {
    const s = JSON.stringify(J(await T.piprail_earnings.invoke({})))
    return /0\.01/.test(s) ? 'the ledger shows the sale' : { fail: s.slice(0, 220) }
  })

  await check('9. it can price a conversion of its earnings, unprompted', async () => {
    const q = await agent.quoteSwap({ from: 'USDC', to: 'native', wantAmount: '0.0005' })
    return q ? `${q.source?.name}: ${q.from?.amountFormatted} USDC → ${q.to?.amountFormatted} SOL` : { fail: 'no route' }
  })

  await check('10. its balance reflects the sale', async () => {
    const wal = J(await T.piprail_wallet.invoke({}))
    const usdc = (wal.holdings ?? []).find((h) => h.symbol === 'USDC')
    return usdc ? `now holds ${usdc.amountFormatted} USDC` : { fail: 'no USDC visible' }
  })
}

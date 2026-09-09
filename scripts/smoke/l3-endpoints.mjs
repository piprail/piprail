/**
 * L3 · ENDPOINTS — our own live 402s, answered by our own client.
 *
 * Everything else tests the SDK against a gate we stood up in-process. This tests the thing a
 * stranger actually meets: the deployed endpoint on piprail.com, over the real internet,
 * through DNS and a CDN and a serverless function.
 *
 * READ-ONLY on purpose. It goes as far as "this challenge is conformant, and my client can
 * price and plan it", and stops before signing. An endpoint that has quietly stopped emitting a
 * payable 402 is a broken shop window, and no unit test can see it.
 */
export const meta = {
  id: 'endpoints',
  layer: 'L3',
  what: 'the live x402 demo endpoint: a conformant 402, quotable and plannable by our own client',
  why: 'a deployed endpoint that stops emitting a payable challenge is a shop nobody can buy from',
  network: true,
  wallets: true,
}

const DEMO = 'https://piprail.com/x402/demo'

export async function run({ sdk, section, check, wallet, REPO }) {
  const { PipRailClient, parseChallenge, classifyChallenge, describeChallenge } = sdk

  section('endpoints · the live demo 402', DEMO)

  let res, body
  await check('the endpoint answers with 402 Payment Required', async () => {
    res = await fetch(DEMO, { headers: { accept: 'application/json' } })
    if (res.status !== 402) return { fail: `status ${res.status} — a payable endpoint must 402` }
    body = await res.json()
    return '402'
  })

  await check('it carries a PAYMENT-REQUIRED header', () => {
    const h = res.headers.get('payment-required')
    return h && h.length > 20 ? `${h.length} bytes` : { fail: `header=${h}` }
  })

  await check('the body is a conformant x402 challenge our own parser reads', () => {
    if (!body) return { fail: 'no body captured' }
    if (body.x402Version !== 2) return { fail: `x402Version=${body.x402Version}` }
    const rails = body.accepts ?? []
    if (!Array.isArray(rails) || rails.length === 0) return { fail: 'no accepts[]' }
    for (const a of rails) {
      for (const f of ['scheme', 'network', 'asset', 'payTo', 'amount']) {
        if (a[f] === undefined) return { fail: `a rail is missing ${f}` }
      }
      if (!/^\d+$/.test(String(a.amount))) return { fail: `amount is not base units: ${a.amount}` }
    }
    return `${rails.length} rail(s): ${rails.map((a) => `${a.scheme}@${a.network}`).join(', ')}`
  })

  await check('every advertised rail names a real, positive price', () => {
    const bad = (body.accepts ?? []).filter((a) => {
      try { return BigInt(a.amount) <= 0n } catch { return true }
    })
    return bad.length === 0 ? 'all rails priced above zero' : { fail: `${bad.length} rail(s) priced at or below zero` }
  })

  await check('the challenge round-trips through the SDK parser', async () => {
    // parseChallenge takes the RESPONSE (it reads PAYMENT-REQUIRED itself) and is ASYNC —
    // forgetting the await yields a Promise, which reads as an empty object, not a failure.
    const parsed = await parseChallenge(res)
    return parsed?.accepts?.length ? `parsed ${parsed.accepts.length} rail(s)` : { fail: 'parseChallenge returned nothing' }
  })

  await check('it self-describes for an agent that has never seen it', () => {
    const ext = body.extensions?.piprail
    if (!ext) return { fail: 'no extensions.piprail — an agent gets no hint how to pay' }
    const missing = ['what', 'pay'].filter((k) => ext[k] === undefined)
    return missing.length === 0 ? `self-describes (${Object.keys(ext).length} keys)` : { fail: `missing ${missing.join(', ')}` }
  })

  section('endpoints · our own client can price and plan it', 'without spending anything')

  const evm = wallet('evm', REPO)

  await check('a client on an OFFERED chain can quote it', async () => {
    // Pick a rail the demo actually offers, then quote with a client bound to that chain.
    const rail = (body.accepts ?? []).find((a) => String(a.network).startsWith('eip155:'))
    if (!rail) return 'no EVM rail offered — nothing to quote from this wallet'
    // Name the chain so its built-in preset (and default RPC) is used; a bare { id } needs an
    // rpcUrl and there is no reason to hand-roll one for a chain the SDK already ships.
    const byId = { 8453: 'base', 1: 'ethereum', 137: 'polygon', 56: 'bnb', 42161: 'arbitrum', 10: 'optimism' }
    const chain = byId[Number(String(rail.network).split(':')[1])]
    if (!chain) return `demo offers ${rail.network}, which this probe has no preset for`
    const q = await new PipRailClient({ chain, wallet: { key: evm.privateKey } })
      .quote(DEMO)
      .catch((e) => ({ err: e }))
    if (q?.err) return { fail: `quote threw ${q.err.constructor?.name}: ${String(q.err.message).slice(0, 90)}` }
    return q ? `${q.amountFormatted} ${q.symbol ?? ''} on ${q.network}` : { fail: 'quote returned null for a live 402' }
  })

  await check('classifyChallenge tells an agent whether it can pay this', () => {
    const rail = (body.accepts ?? [])[0]
    const triage = classifyChallenge(body, { network: rail.network, schemes: ['onchain-proof', 'exact'] })
    return triage ? `verdict: ${triage.verdict ?? JSON.stringify(triage).slice(0, 70)}` : { fail: 'no triage' }
  })

  await check('describeChallenge renders it for a human or a model', () => {
    const text = describeChallenge(body)
    return typeof text === 'string' && text.length > 20 ? `${text.length} chars` : { fail: 'empty description' }
  })
}

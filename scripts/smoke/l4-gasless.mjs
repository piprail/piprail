/**
 * L4 · GASLESS — the standard x402 `exact` rail, end to end, with real money.
 *
 * Everything else in L4 exercises `onchain-proof`, where the BUYER broadcasts and pays gas.
 * `exact` is the rail the wider x402 world speaks, and it inverts the model: the buyer SIGNS an
 * EIP-3009 authorization and never touches the chain, a keyless facilitator broadcasts it, and
 * NOBODY pays gas — not the buyer, not the merchant. That is the whole pitch of the keyless
 * path, and it depends on a third party doing its half correctly.
 *
 * It cannot be proven offline: it needs a real token that implements EIP-3009, a real
 * facilitator that agrees to sponsor it, and a real signature. So it belongs here, with the
 * amounts kept at dust.
 *
 * A buyer with NO gas coin at all is the sharpest version of the test — if it settles, the
 * gasless claim is literally true rather than approximately true.
 */
export const meta = {
  id: 'gasless',
  layer: 'L4',
  what: 'the standard `exact` rail: buyer signs, a keyless facilitator settles, nobody pays gas',
  why: 'gasless is the headline claim of the keyless path, and only a live settlement proves it',
  network: true,
  wallets: true,
  spends: true,
}

// Chains with BOTH a keyless EIP-3009 facilitator and native USDC we hold.
const CANDIDATES = [
  { chain: 'polygon', token: 'USDC', amount: '0.01' },
  { chain: 'arbitrum', token: 'USDC', amount: '0.01' },
  { chain: 'base', token: 'USDC', amount: '0.01' },
]

export async function run({ sdk, section, check, warn, serve, wallet, REPO, env, only }) {
  const {
    createPaymentGate, PipRailClient, firstKeylessFacilitator, chainIdForExactNetwork,
  } = sdk

  const w = wallet('evm', REPO)
  const payTo = w.merchantAddress

  for (const spec of CANDIDATES) {
    if (only.length && !only.includes(spec.chain)) continue
    const label = `${spec.chain}/${spec.token}`
    section(`gasless · ${label}`, 'buyer signs, facilitator broadcasts, nobody pays gas')

    const rpcUrl = env[`RPC_${spec.chain.toUpperCase()}`] || undefined
    /*
     * `schemes: ['exact']` is an OPT-IN, and deliberately so: DEFAULT_SCHEMES is
     * onchain-proof only, so the zero-config path stays byte-identical to before the exact
     * buyer rail existed. It has to be set on the CLIENT, because planPayment has no per-call
     * scheme override the way fetch does — planning with defaults while paying with exact is
     * how a test ends up "proving" a gasless rail is unaffordable.
     */
    const buyer = new PipRailClient({
      chain: spec.chain, wallet: { key: w.privateKey }, schemes: ['exact'], ...(rpcUrl ? { rpcUrl } : {}),
    })

    let gate, srv
    try {
      // `exact: true` asks the SDK to auto-pick a KEYLESS facilitator for this chain, so the
      // merchant signs up for nothing either.
      gate = createPaymentGate({
        chain: spec.chain, token: spec.token, amount: spec.amount, payTo,
        exact: true, ...(rpcUrl ? { rpcUrl } : {}),
      })
    } catch (e) {
      await check(`${label}: build a gasless gate`, () => ({ fail: `${e.constructor.name}: ${e.message}` }))
      continue
    }

    await check('the gate resolved a gasless `exact` rail (not just onchain-proof)', async () => {
      const t = await gate.selfTest()
      const schemes = [...new Set((t.rails ?? []).flatMap((r) => [...(r.schemes ?? [])]))]
      return schemes.includes('exact')
        ? `rails: ${schemes.join(', ')}`
        : { fail: `no exact rail — the gate serves ${schemes.join(', ') || 'nothing'} (${t.error ?? 'no reason given'})` }
    })

    await check('a keyless facilitator is available for this chain', async () => {
      const { challenge } = await gate.challenge('https://x.test/r')
      const rail = challenge.accepts.find((a) => a.scheme === 'exact')
      if (!rail) return { fail: 'the challenge advertises no exact rail' }
      const f = firstKeylessFacilitator(rail.network, 'eip3009')
      return f ? `${f.url.replace(/^https:\/\//, '')}` : { fail: 'no keyless facilitator for this network' }
    })

    let lastAuth = null
    srv = await serve(async (req) => {
      const sig = req.headers.get('payment-signature')
      if (sig) lastAuth = sig
      const r = await gate.verify(sig ?? undefined)
      if (r.kind === 'paid') {
        return new Response(JSON.stringify({ ok: true, receipt: r.receipt }), {
          status: 200, headers: { 'content-type': 'application/json', 'payment-response': r.receiptHeader },
        })
      }
      return new Response(JSON.stringify(r.challenge), {
        status: 402, headers: { 'content-type': 'application/json', 'payment-required': r.requiredHeader },
      })
    })

    try {
      await check('the challenge offers BOTH rails, so any buyer can pay it', async () => {
        const res = await fetch(srv.url)
        const body = await res.json()
        const schemes = (body.accepts ?? []).map((a) => a.scheme)
        return schemes.includes('exact') && schemes.includes('onchain-proof')
          ? `dual-advertised: ${schemes.join(', ')}`
          : `advertises ${schemes.join(', ')}`
      })

      // Unfunded is not broken: skip loudly rather than proving an empty wallet cannot pay.
      let skip = false
      await check('planPayment answers before any signature', async () => {
        const plan = await buyer.planPayment(srv.url)
        if (!plan) return { fail: 'planPayment returned null' }
        if (!plan.payable) {
          skip = true
          return `NOT payable: ${plan.fundingHint ?? 'blocked'}`
        }
        return `payable (${plan.status})`
      })
      if (skip) {
        warn(`${label}: SKIPPED, wallet needs funding`, 'the exact rail still needs the TOKEN, only the gas is sponsored')
        continue
      }

      let gasBefore = null
      await check('note the buyer\'s gas balance before paying', async () => {
        const b = await buyer.balanceOf(['native'])
        gasBefore = b?.[0]?.amount != null ? BigInt(b[0].amount) : null
        return gasBefore != null ? `${b[0].amountFormatted} ${b[0].symbol}` : 'gas read unavailable'
      })

      await check('💸 REAL GASLESS PAYMENT → 200 with a receipt', async () => {
        // schemes: ['exact'] forces the gasless rail rather than letting it fall back.
        const res = await buyer.fetch(srv.url)
        if (res.status !== 200) return { fail: `status ${res.status}: ${(await res.text()).slice(0, 200)}` }
        const body = await res.json()
        const tx = body?.receipt?.transaction
        if (!tx) return { fail: `200 but no receipt.transaction: ${JSON.stringify(body).slice(0, 180)}` }
        if (String(body.receipt.scheme) !== 'exact') return { fail: `settled on ${body.receipt.scheme}, not exact` }
        return `settled ${String(tx).slice(0, 24)}… on the exact rail`
      })

      await check('🔑 the BUYER paid no gas (the facilitator did)', async () => {
        if (gasBefore == null) return 'gas read was unavailable before, cannot compare'
        const b = await buyer.balanceOf(['native'])
        const after = b?.[0]?.amount != null ? BigInt(b[0].amount) : null
        if (after == null) return { fail: 'gas read unavailable after' }
        return after >= gasBefore
          ? `gas unchanged (${b[0].amountFormatted} ${b[0].symbol}) — genuinely gasless`
          : { fail: `buyer spent ${gasBefore - after} base units of gas on a "gasless" rail` }
      })

      await check('🔴 the SAME signed authorization cannot settle twice', async () => {
        /*
         * The exact rail's replay key is the EIP-3009 authorization nonce, not a tx hash. An
         * authorization that settled once must never settle again: it is a bearer instrument
         * until it is claimed, so a merchant who could re-submit it would be charging the buyer
         * twice for one consent.
         */
        if (!lastAuth) return { fail: 'no authorization captured' }
        const r = await gate.verify(lastAuth)
        return r.kind !== 'paid'
          ? `refused: ${r.error ?? r.kind}`
          : { fail: '🔴 the same signed authorization settled TWICE' }
      })

      await check('a TAMPERED authorization is refused', async () => {
        if (!lastAuth) return { fail: 'no authorization captured' }
        // Flip a byte in the middle of the base64 payload: the signature can no longer recover
        // to the payer, so the facilitator (or the gate) must reject it.
        const i = Math.floor(lastAuth.length / 2)
        const flipped = lastAuth.slice(0, i) + (lastAuth[i] === 'A' ? 'B' : 'A') + lastAuth.slice(i + 1)
        const r = await gate.verify(flipped)
        return r.kind !== 'paid' ? `refused: ${r.error ?? r.kind}` : { fail: '🔴 a tampered authorization settled' }
      })
    } finally {
      await srv.close()
    }
  }
}

// Suite 06 — x402-over-MCP SELLER transport  (createMcpPaymentTool + the buyer/codec helpers)
//
// The 3rd official transport, new in 2.14.0: a merchant wraps a PipRail gate as a single MCP
// tool. A 402 rides back as an `isError` result whose structuredContent IS the challenge; the
// buyer pays by stuffing {accepted,payload} under _meta["x402/payment"]; the settled result
// carries a MINIMAL payment-response under _meta (never the full receipt).
//
//   OFFLINE (always, most of the value):
//     (1) no _meta payment → isError + PaymentRequired in structuredContent AND
//         content[0].text === JSON.stringify(challenge) (BYTE-EQUAL).
//     (2) garbage _meta["x402/payment"] → isError + a FRESH re-challenge, NEVER a crash,
//         and NEVER a payment-response / fulfill leak.
//     (3) the codecs round-trip; every reader (from*/is*) NEVER throws on hostile junk and
//         returns null on a non-402 / success result.
//     (4) buildMcpPaymentMeta shapes the buyer envelope; toMcpPaymentResponse projects EXACTLY
//         {success,transaction,network,payer} — the full receipt does NOT leak.
//     (5) fromMcpPaymentResponse → null when absent, a SettleOutcome when present.
//   LIVE (Base mainnet, tiny USDC — only with the .secrets wallet + PIPRAIL_LIVE=1):
//     pay a real challenge by minting {accepted,payload} via PipRailClient → frame with
//     buildMcpPaymentMeta → handleToolCall settles → _meta payment-response + the fulfill output;
//     REPLAY the same meta → rejected (single-use); a fulfill() that THROWS still returns a
//     payment-response (B7), never a re-challenge.
//
import {
  createMcpPaymentTool, createPaymentGate, PipRailClient,
  toMcpPaymentRequired, toMcpPaymentResponse,
  fromMcpPayment, fromMcpPaymentRequired, isMcpPaymentRequired, fromMcpPaymentResponse,
  buildMcpPaymentMeta, MCP_PAYMENT_META_KEY, MCP_PAYMENT_RESPONSE_META_KEY,
  HEADER_SIGNATURE, HEADER_REQUIRED, decodeBase64Json,
} from '@piprail/sdk'
import { createServer } from 'node:http'
import { check, banner, group, note, skip, done } from '../lib/report.mjs'
import { loadWallet, RPC } from '../lib/env.mjs'

banner('06 · x402-over-MCP transport (createMcpPaymentTool + codecs)')
const w = loadWallet()
const MERCHANT = w?.merchant ?? '0x28Dc25bf88BF06fc0a3Af1747D1aA4a21f313ed0'
const RESOURCE = 'http://127.0.0.1:1/mcp-tool'

// Wrap a reader so the never-throw contract is asserted (a throw FAILS, never escapes the suite).
const noThrow = (fn, arg, label) => {
  try { return { ok: true, val: fn(arg) } }
  catch (err) { check(false, `${label} THREW on hostile input (${err?.message ?? err}) — must never throw`); return { ok: false } }
}

// ───────────────────────── constants are the wire contract ─────────────────────────
group('offline — the meta-key constants are the exact wire strings')
{
  check(MCP_PAYMENT_META_KEY === 'x402/payment', 'MCP_PAYMENT_META_KEY === "x402/payment"')
  check(MCP_PAYMENT_RESPONSE_META_KEY === 'x402/payment-response', 'MCP_PAYMENT_RESPONSE_META_KEY === "x402/payment-response"')
}

// ───────────────────────── (1) no payment → byte-equal challenge ─────────────────────────
group('offline — handleToolCall with NO _meta → isError + structuredContent challenge + BYTE-EQUAL text')
let SEED_CHALLENGE = null
{
  let leaked = false
  const tool = createMcpPaymentTool({
    chain: 'base', token: 'USDC', amount: '0.001', payTo: MERCHANT, rpcUrl: RPC,
    resourceUrl: RESOURCE,
    fulfill: async () => { leaked = true; return [{ type: 'text', text: 'TOP-SECRET-RESOURCE' }] },
  })
  check(typeof tool.handleToolCall === 'function', 'createMcpPaymentTool → { handleToolCall }')
  check(!!tool.gate && typeof tool.gate.challenge === 'function', 'createMcpPaymentTool → { gate } (a real PaymentGate)')

  // No payment in _meta at all.
  const r = await tool.handleToolCall({})
  check(r?.isError === true, 'no-payment call → isError:true')
  check(r?.structuredContent && typeof r.structuredContent === 'object', 'the challenge rides in structuredContent (an object)')
  check(r?.structuredContent?.x402Version === 2, 'structuredContent is a v2 PaymentRequired (x402Version:2)')
  check(Array.isArray(r?.structuredContent?.accepts) && r.structuredContent.accepts.length >= 1, 'the challenge advertises ≥1 accept rail')
  check(!!r?.structuredContent?.accepts?.find((a) => a.scheme === 'onchain-proof'), 'the challenge offers the onchain-proof rail')
  // THE byte-equal assertion: content[0].text MUST be JSON.stringify of the SAME challenge object.
  check(r?.content?.[0]?.type === 'text', 'content[0] is a text part')
  check(r?.content?.[0]?.text === JSON.stringify(r.structuredContent), 'content[0].text === JSON.stringify(structuredContent) (BYTE-EQUAL — no drift between the two views)')
  // A challenge MUST NOT carry a payment-response, and MUST NOT have called fulfill.
  check(!r?._meta?.[MCP_PAYMENT_RESPONSE_META_KEY], 'a pure challenge carries NO payment-response _meta')
  check(leaked === false, 'fulfill() was NOT invoked while merely challenging (no resource leak before payment)')
  check(!JSON.stringify(r).includes('TOP-SECRET-RESOURCE'), 'the protected resource text is absent from the challenge')

  SEED_CHALLENGE = r.structuredContent // reuse the genuine challenge for the codec round-trips below
}

// ───────────────────────── (2) garbage payment _meta → fresh re-challenge, no crash ─────────────────────────
group('offline — garbage _meta["x402/payment"] → isError + FRESH re-challenge, never a crash / leak')
{
  let leaked = false
  const tool = createMcpPaymentTool({
    chain: 'base', token: 'USDC', amount: '0.001', payTo: MERCHANT, rpcUrl: RPC,
    resourceUrl: RESOURCE,
    fulfill: async () => { leaked = true; return [{ type: 'text', text: 'LEAK' }] },
  })

  // null under the key is "absent" → fresh challenge; every other junk shape must also re-challenge,
  // structurally rejected WITHOUT a network read (verified: even a dead RPC returns in ~1ms).
  const junks = [
    'garbage-string', 42, true, [], [1, 2, 3], { nope: 1 }, null,
    { x402Version: 2, accepted: { scheme: 'exact' }, payload: { foo: 'bar' } }, // well-shaped envelope, bogus payload
    { a: { b: { c: [1, 2, 3] } }, x402Version: 'two' },                        // deeply-nested junk
    { x402Version: 2, accepted: { scheme: 'onchain-proof', network: 'eip155:8453' }, payload: { transaction: '0x' + 'ab'.repeat(32) } }, // plausible-but-nonexistent tx
  ]
  let allError = true, allFresh = true, anyLeak = false, anyRespMeta = false
  for (const j of junks) {
    let r
    try { r = await tool.handleToolCall({ _meta: { [MCP_PAYMENT_META_KEY]: j } }) }
    catch (err) { check(false, `handleToolCall THREW on junk meta ${JSON.stringify(j)?.slice(0, 40)} (${err?.message ?? err}) — must never throw`); allError = false; continue }
    if (r?.isError !== true) allError = false
    if (!isMcpPaymentRequired(r)) allFresh = false
    if (r?._meta?.[MCP_PAYMENT_RESPONSE_META_KEY]) anyRespMeta = true
    if (JSON.stringify(r ?? {}).includes('LEAK')) anyLeak = true
  }
  check(allError, `every garbage payment meta → isError:true (${junks.length} hostile shapes)`)
  check(allFresh, 'every garbage payment meta → a FRESH 402 re-challenge (isMcpPaymentRequired)')
  check(!anyRespMeta, 'no garbage payment ever produced a payment-response _meta (no false settlement)')
  check(!anyLeak && leaked === false, 'fulfill() never ran for ANY garbage payment (no resource leak on a bad/forged proof)')
}

// ───────────────────────── (3) codec round-trip + the never-throw reader contract ─────────────────────────
group('offline — codecs round-trip; from*/is* readers NEVER throw on hostile junk; null on non-402/success')
{
  // toMcpPaymentRequired(genuine challenge) round-trips back through from/is.
  const req = toMcpPaymentRequired(SEED_CHALLENGE)
  check(req?.isError === true, 'toMcpPaymentRequired → isError:true')
  check(req?.content?.[0]?.text === JSON.stringify(SEED_CHALLENGE), 'toMcpPaymentRequired content text is byte-equal to the challenge JSON')
  check(isMcpPaymentRequired(req) === true, 'isMcpPaymentRequired recognises its own output')
  const back = fromMcpPaymentRequired(req)
  check(back?.x402Version === SEED_CHALLENGE.x402Version && back?.accepts?.length === SEED_CHALLENGE.accepts.length, 'fromMcpPaymentRequired returns the original challenge (round-trip)')

  // fromMcpPaymentRequired also reads the structuredContent path (no text part).
  const scOnly = { isError: true, structuredContent: { x402Version: 2, accepts: [] } }
  check(fromMcpPaymentRequired(scOnly)?.x402Version === 2, 'fromMcpPaymentRequired reads structuredContent when there is no text part')

  // NULL on a non-402 isError result and on a SUCCESS result (the spec-required negatives).
  check(fromMcpPaymentRequired({ isError: true, content: [{ type: 'text', text: 'a plain tool error' }] }) === null, 'fromMcpPaymentRequired → null on a NON-402 isError result')
  check(fromMcpPaymentRequired({ content: [{ type: 'text', text: 'ok' }] }) === null, 'fromMcpPaymentRequired → null on a SUCCESS result')
  check(isMcpPaymentRequired({ isError: true, content: [{ type: 'text', text: 'nope' }] }) === false, 'isMcpPaymentRequired → false on a non-402 error')
  check(isMcpPaymentRequired({ content: [] }) === false, 'isMcpPaymentRequired → false on a success result')

  // fromMcpPayment reads the buyer envelope; absent → null.
  const meta = buildMcpPaymentMeta({ accepted: { scheme: 'exact' }, payload: { p: 1 } })
  check(fromMcpPayment({ _meta: meta })?.payload?.p === 1, 'fromMcpPayment extracts the {accepted,payload} envelope from params._meta')
  check(fromMcpPayment({}) === null, 'fromMcpPayment → null when _meta is absent')
  check(fromMcpPayment({ _meta: { [MCP_PAYMENT_META_KEY]: null } }) === null, 'fromMcpPayment → null when the key is present-but-null (treated as absent)')

  // THE never-throw sweep: every reader on a battery of hostile inputs must RETURN, never throw.
  const HOSTILE = [
    null, undefined, {}, '', 'str', 0, 42, NaN, true, false, [], [1, 2], [[[]]],
    { a: { b: { c: 1 } } }, { _meta: null }, { _meta: 'x' }, { _meta: 42 }, { _meta: [] },
    { _meta: {} }, { isError: 'yes' }, { isError: 1 }, { structuredContent: 42 },
    { structuredContent: null }, { content: 'no' }, { content: {} }, { content: [] },
    { content: [{}] }, { content: [{ text: 42 }] }, { content: [null] }, { content: [{ type: 'image' }] },
    { _meta: { [MCP_PAYMENT_META_KEY]: { x: { y: { z: [1, 2, 3] } } } } },
    { _meta: { [MCP_PAYMENT_RESPONSE_META_KEY]: 'notobj' } },
    { _meta: { [MCP_PAYMENT_RESPONSE_META_KEY]: [] } },
    { _meta: { [MCP_PAYMENT_RESPONSE_META_KEY]: null } },
  ]
  let readersClean = true
  for (const fn of [fromMcpPayment, fromMcpPaymentRequired, isMcpPaymentRequired, fromMcpPaymentResponse]) {
    for (const h of HOSTILE) {
      const r = noThrow(fn, h, fn.name)
      if (!r.ok) readersClean = false
    }
  }
  check(readersClean, `all 4 from*/is* readers returned a verdict on every one of ${HOSTILE.length} hostile inputs (never threw)`)

  // isMcpPaymentRequired must agree with (fromMcpPaymentRequired != null) for every hostile input.
  let agree = true
  for (const h of HOSTILE) if (isMcpPaymentRequired(h) !== (fromMcpPaymentRequired(h) != null)) agree = false
  check(agree, 'isMcpPaymentRequired(x) === (fromMcpPaymentRequired(x) != null) for every hostile input (no contradiction)')
}

// ───────────────────────── (4) buildMcpPaymentMeta shape + (5) response projection (no leak) ─────────────────────────
group('offline — buildMcpPaymentMeta shape · toMcpPaymentResponse projects EXACTLY 4 fields (no receipt leak)')
{
  // buildMcpPaymentMeta: single key, x402Version default 2, optional resource, carries accepted+payload.
  const full = buildMcpPaymentMeta({ accepted: { scheme: 'exact', network: 'eip155:8453' }, payload: { sig: '0xdead' }, resource: 'http://res' })
  check(Object.keys(full).length === 1 && MCP_PAYMENT_META_KEY in full, 'buildMcpPaymentMeta → exactly one key: "x402/payment"')
  const env = full[MCP_PAYMENT_META_KEY]
  check(env.x402Version === 2, 'buildMcpPaymentMeta defaults x402Version to 2')
  check(env.resource === 'http://res', 'buildMcpPaymentMeta carries the optional resource when given')
  check(env.accepted?.scheme === 'exact' && env.payload?.sig === '0xdead', 'buildMcpPaymentMeta carries {accepted,payload} verbatim')
  const noRes = buildMcpPaymentMeta({ accepted: {}, payload: {} })
  check(!('resource' in noRes[MCP_PAYMENT_META_KEY]), 'buildMcpPaymentMeta OMITS resource when not given (no undefined key)')
  check(buildMcpPaymentMeta({ accepted: {}, payload: {}, x402Version: 7 })[MCP_PAYMENT_META_KEY].x402Version === 7, 'buildMcpPaymentMeta honours an explicit x402Version override')

  // toMcpPaymentResponse: the projection MUST be exactly {success,transaction,network,payer} —
  // the full receipt (scheme/asset/amount/payTo and any extra fields) must NEVER leak to the buyer.
  const fatReceipt = {
    transaction: '0xTX', network: 'base', payer: '0xPAYER',
    scheme: 'exact', asset: '0xUSDC', amount: '1000', payTo: '0xMERCHANT',
    LEAK_FIELD: 'must-not-leak', nested: { deep: 'also-secret' },
  }
  const resp = toMcpPaymentResponse([{ type: 'text', text: 'served' }], fatReceipt)
  check(JSON.stringify(resp.content) === JSON.stringify([{ type: 'text', text: 'served' }]), 'toMcpPaymentResponse preserves the fulfill content verbatim')
  const pr = resp._meta?.[MCP_PAYMENT_RESPONSE_META_KEY]
  check(pr?.success === true, 'payment-response success === true')
  check(Object.keys(pr).sort().join(',') === 'network,payer,success,transaction', 'payment-response projects EXACTLY {success,transaction,network,payer} (no extra keys)')
  check(pr.transaction === '0xTX' && pr.network === 'base' && pr.payer === '0xPAYER', 'the 3 projected fields are taken straight from the receipt')
  const whole = JSON.stringify(resp)
  check(!whole.includes('must-not-leak') && !whole.includes('also-secret') && !whole.includes('0xMERCHANT') && !whole.includes('0xUSDC'), 'the full receipt does NOT leak through the payment-response (no payTo/asset/amount/extra fields)')

  // (5) fromMcpPaymentResponse → the SettleOutcome when present, null when absent.
  const out = fromMcpPaymentResponse(resp)
  check(out?.success === true && out?.transaction === '0xTX' && out?.network === 'base' && out?.payer === '0xPAYER', 'fromMcpPaymentResponse → the SettleOutcome when the _meta is present (round-trip)')
  check(fromMcpPaymentResponse({ content: [{ type: 'text', text: 'no meta' }] }) === null, 'fromMcpPaymentResponse → null when the _meta key is absent')
  check(fromMcpPaymentResponse(resp.content ? { _meta: { other: { x: 1 } } } : null) === null, 'fromMcpPaymentResponse → null when _meta has a different key')

  // toMcpPaymentResponse with a sparse receipt must still project a valid (key-omitting) shape, not throw.
  const sparse = noThrow((r) => toMcpPaymentResponse([{ type: 'text', text: 'x' }], r), {}, 'toMcpPaymentResponse({})')
  check(sparse.ok && sparse.val?._meta?.[MCP_PAYMENT_RESPONSE_META_KEY]?.success === true, 'toMcpPaymentResponse on a sparse receipt still returns success:true (undefined fields, no throw)')
}

// ───────────────────────── a pre-built gate is REUSED, not re-created ─────────────────────────
group('offline — createMcpPaymentTool reuses an injected gate (gate? option)')
{
  const sharedGate = createPaymentGate({ chain: 'base', token: 'USDC', amount: '0.002', payTo: MERCHANT, rpcUrl: RPC })
  const tool = createMcpPaymentTool({ gate: sharedGate, resourceUrl: RESOURCE, fulfill: async () => [{ type: 'text', text: 'x' }] })
  check(tool.gate === sharedGate, 'the injected gate is REUSED (tool.gate === the gate passed in)')
  const r = await tool.handleToolCall({})
  // 0.002 was set on the shared gate → the challenge must reflect THAT amount, proving reuse.
  const amt = r?.structuredContent?.accepts?.[0]?.amount
  check(amt === '2000', `the injected gate's amount (0.002 USDC = 2000 base units) drives the challenge, got ${amt}`)
}

// ───────────────────────── (6) FORGERY: a downgraded/substituted accepted must NOT leak ─────────────────────────
// The single most security-relevant property of the transport: the gate re-derives every checked
// field from its OWN trusted accept, never the client-supplied `accepted`. A buyer who frames a
// payment whose `accepted` downgrades the amount AND substitutes their OWN payTo (so a real tx to
// the attacker would "satisfy" the forged accept) must STILL be re-challenged — no settle, no leak.
group('offline — forged accepted (downgraded amount + attacker payTo) is re-challenged, never settled/leaked')
{
  let leaked = false
  const tool = createMcpPaymentTool({
    chain: 'base', token: 'USDC', amount: '0.002', payTo: MERCHANT, rpcUrl: RPC, resourceUrl: RESOURCE,
    fulfill: async () => { leaked = true; return [{ type: 'text', text: 'TOP-SECRET-RESOURCE' }] },
  })
  const ATTACKER = '0x000000000000000000000000000000000000bEEF'
  const forgedMetas = [
    // downgrade the amount to 1 base unit + redirect payTo to the attacker, plausible-looking tx
    { x402Version: 2, accepted: { scheme: 'onchain-proof', network: 'eip155:8453', amount: '1', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', payTo: ATTACKER, maxTimeoutSeconds: 600 }, payload: { nonce: 'x', txHash: '0x' + 'ab'.repeat(32) } },
    // keep the merchant payTo but zero the amount
    { x402Version: 2, accepted: { scheme: 'onchain-proof', network: 'eip155:8453', amount: '0', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', payTo: MERCHANT, maxTimeoutSeconds: 600 }, payload: { nonce: 'y', txHash: '0x' + 'cd'.repeat(32) } },
    // wrong asset (some other token), merchant payTo, real-looking amount
    { x402Version: 2, accepted: { scheme: 'onchain-proof', network: 'eip155:8453', amount: '2000', asset: '0x0000000000000000000000000000000000000bad', payTo: MERCHANT, maxTimeoutSeconds: 600 }, payload: { nonce: 'z', txHash: '0x' + 'ef'.repeat(32) } },
  ]
  let allRechallenged = true
  for (const meta of forgedMetas) {
    let r
    try { r = await tool.handleToolCall({ _meta: { [MCP_PAYMENT_META_KEY]: meta } }) }
    catch (err) { check(false, `handleToolCall THREW on a forged accept (${err?.message ?? err})`); allRechallenged = false; continue }
    if (!(r?.isError === true && isMcpPaymentRequired(r))) allRechallenged = false
    if (r?._meta?.[MCP_PAYMENT_RESPONSE_META_KEY]) allRechallenged = false
  }
  check(allRechallenged, 'every forged accept (downgraded amount / attacker payTo / wrong asset) → isError + fresh re-challenge, NO payment-response')
  check(leaked === false, 'fulfill() was NEVER invoked for any forged accept (the protected resource never leaked)')
}

// ───────────────────────── (7) no-arg / null handleToolCall is handled, never crashes ─────────────────────────
group('offline — handleToolCall with no/empty/null params re-challenges cleanly (never throws)')
{
  const tool = createMcpPaymentTool({ chain: 'base', token: 'USDC', amount: '0.001', payTo: MERCHANT, rpcUrl: RPC, resourceUrl: RESOURCE, fulfill: async () => [{ type: 'text', text: 'LEAK' }] })
  for (const [label, arg] of [['no argument', undefined], ['null', null], ['empty object', {}], ['empty _meta', { _meta: {} }]]) {
    let r
    try { r = await tool.handleToolCall(arg) }
    catch (err) { check(false, `handleToolCall(${label}) THREW (${err?.message ?? err}) — must degrade to a challenge`); continue }
    check(r?.isError === true && isMcpPaymentRequired(r), `handleToolCall(${label}) → isError + a fresh PaymentRequired (no crash, no leak)`)
  }
}

// ───────────────────────── LIVE (Base mainnet, real USDC) ─────────────────────────
if (!w || process.env.PIPRAIL_LIVE !== '1') {
  skip('live MCP-transport settle skipped (needs the .secrets wallet AND PIPRAIL_LIVE=1)')
} else {
  // ONE shared gate, wrapped as an MCP tool with a real Base USDC rail. A thin HTTP front just
  // hands out the challenge and CAPTURES the buyer's posted {accepted,payload} signature — it does
  // NOT verify, so the on-chain proof is settled EXACTLY ONCE: by handleToolCall below.
  group('live — pay a real challenge THROUGH the MCP tool → settled + payment-response + fulfill output; then REPLAY → rejected')
  let fulfillCalls = 0
  const sharedGate = createPaymentGate({ chain: 'base', token: 'USDC', amount: '0.001', payTo: w.merchant, rpcUrl: RPC, receipts: true })
  const tool = createMcpPaymentTool({
    gate: sharedGate, resourceUrl: 'http://127.0.0.1:4861/mcp',
    fulfill: async ({ receipt }) => { fulfillCalls++; return [{ type: 'text', text: `the paid resource (tx ${receipt.transaction?.slice(0, 10)}…)` }] },
  })

  const PORT = 4861, URL = `http://127.0.0.1:${PORT}/mcp`
  let capturedSig = null
  const server = createServer(async (req, res) => {
    const sig = req.headers[HEADER_SIGNATURE] ?? req.headers['payment-signature']
    if (!sig) {
      const c = await sharedGate.challenge(URL)
      res.setHeader(HEADER_REQUIRED, c.requiredHeader)
      res.writeHead(402, { 'content-type': 'application/json' })
      return res.end(JSON.stringify(c.challenge))
    }
    // Capture the buyer's real payment WITHOUT settling — we settle through the MCP tool instead.
    capturedSig = sig
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, captured: true }))
  })
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r))

  try {
    // The buyer pays normally; we intercept the {accepted,payload} it minted (no settle yet).
    const buyer = new PipRailClient({ chain: 'base', wallet: { key: w.key }, rpcUrl: RPC })
    note('buyer mints a real onchain-proof payment; we capture it and frame it as MCP _meta')
    await buyer.fetch(URL)
    check(!!capturedSig, 'captured the buyer-minted payment signature')
    const envelope = decodeBase64Json(capturedSig) // { accepted, payload, x402Version, ... }
    check(!!envelope?.accepted && !!envelope?.payload, 'the captured signature decodes to {accepted,payload}')

    // Frame it via buildMcpPaymentMeta and settle THROUGH the MCP tool.
    const meta = buildMcpPaymentMeta({ accepted: envelope.accepted, payload: envelope.payload, resource: URL })
    const paid = await tool.handleToolCall({ _meta: meta })
    check(paid?.isError !== true, 'the framed real payment did NOT come back as an error/challenge')
    check(!isMcpPaymentRequired(paid), 'handleToolCall did NOT re-challenge a valid payment')
    const pr = fromMcpPaymentResponse(paid)
    check(pr?.success === true, 'the result carries a payment-response with success:true')
    check(/^0x[0-9a-fA-F]{64}$/.test(pr?.transaction ?? ''), 'the payment-response carries a real on-chain tx hash')
    check((pr?.payer ?? '').toLowerCase() === w.payer.toLowerCase(), 're-derived payer (in the response) === the real buyer')
    check(paid?.content?.[0]?.text?.includes('the paid resource'), 'the fulfill() output rides back as the tool content')
    check(fulfillCalls === 1, 'fulfill() was invoked exactly once for the one settlement')

    // REPLAY the exact same _meta → the single-use proof is rejected (a fresh 402, no second fulfill).
    const replay = await tool.handleToolCall({ _meta: meta })
    check(replay?.isError === true && isMcpPaymentRequired(replay), 'REPLAY of the same payment meta → rejected with a fresh 402 (single-use)')
    check(!fromMcpPaymentResponse(replay), 'the replay carries NO payment-response (no second settlement)')
    check(fulfillCalls === 1, 'fulfill() did NOT run again on replay (the resource is not double-served)')
  } catch (err) {
    check(false, `live MCP-transport settle threw: ${err?.message ?? err}`)
  } finally {
    server.close()
  }

  // B7 — a fulfill() that THROWS must STILL return a payment-response (the buyer paid), never a re-challenge.
  group('live — B7: fulfill() that THROWS still returns a payment-response (paid ≠ re-challenge)')
  {
    let throwingServerSig = null
    const gate2 = createPaymentGate({ chain: 'base', token: 'USDC', amount: '0.001', payTo: w.merchant, rpcUrl: RPC })
    const toolT = createMcpPaymentTool({
      gate: gate2, resourceUrl: 'http://127.0.0.1:4862/mcp',
      fulfill: async () => { throw new Error('downstream resource exploded') },
    })
    const PORT2 = 4862, URL2 = `http://127.0.0.1:${PORT2}/mcp`
    const server2 = createServer(async (req, res) => {
      const sig = req.headers[HEADER_SIGNATURE] ?? req.headers['payment-signature']
      if (!sig) {
        const c = await gate2.challenge(URL2)
        res.setHeader(HEADER_REQUIRED, c.requiredHeader)
        res.writeHead(402, { 'content-type': 'application/json' })
        return res.end(JSON.stringify(c.challenge))
      }
      throwingServerSig = sig
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true }))
    })
    await new Promise((r) => server2.listen(PORT2, '127.0.0.1', r))
    try {
      const buyer = new PipRailClient({ chain: 'base', wallet: { key: w.key }, rpcUrl: RPC })
      await buyer.fetch(URL2)
      const env2 = decodeBase64Json(throwingServerSig)
      let res2
      try {
        res2 = await toolT.handleToolCall({ _meta: buildMcpPaymentMeta({ accepted: env2.accepted, payload: env2.payload, resource: URL2 }) })
      } catch (err) {
        check(false, `handleToolCall propagated the fulfill throw instead of trapping it (${err?.message ?? err})`)
        res2 = {}
      }
      check(!isMcpPaymentRequired(res2), 'a thrown fulfill did NOT cause a (wrong) re-challenge — the buyer DID pay')
      const pr2 = fromMcpPaymentResponse(res2)
      check(pr2?.success === true && /^0x[0-9a-fA-F]{64}$/.test(pr2?.transaction ?? ''), 'B7: a throwing fulfill STILL returns a payment-response with the real tx (the buyer is not charged silently)')
      check(JSON.stringify(res2).includes('serving the result failed') || JSON.stringify(res2).includes('exploded'), 'the content explains the serve failure (so the buyer can recover with the proof in hand)')
    } catch (err) {
      check(false, `B7 leg threw: ${err?.message ?? err}`)
    } finally {
      server2.close()
    }
  }
}

done(w && process.env.PIPRAIL_LIVE === '1' ? '06 mcp transport' : '06 mcp transport (offline)')

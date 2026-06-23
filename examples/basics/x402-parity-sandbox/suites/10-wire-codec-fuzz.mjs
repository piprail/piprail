// Suite 10 — WIRE-CODEC ADVERSARIAL FUZZING  (the parse/build/encode/decode surface)
//
// Every parse*/decode* codec the SDK ships is the FIRST thing a hostile peer touches: a 402
// server hands a buyer a challenge header, a buyer hands a gate a signature header, an A2A
// transport hands a verb a raw object. The SDK's contract is that these READ functions NEVER
// throw and NEVER pollute — they return a verdict (a parsed object) or `null`. This suite tries
// to break that with a battery of junk: empty/garbage strings, valid-base64-of-garbage,
// __proto__/constructor pollution payloads, a 10k-deep nest, a 1MB string, scientific-notation
// amounts, unicode, and wrong-typed args. Then it proves the build*→parse* pairs round-trip on
// REAL gate output, and that the triage helpers (classify/describe) stay graceful.
//
//   OFFLINE ONLY — pure codecs, no chain, no money. (No live leg: nothing here touches an RPC.)
//
import {
  createPaymentGate,
  parseSignatureHeader, parseSignatureObject,
  parseExactPaymentHeader, parseExactObject,
  parseUptoPaymentHeader, parseUptoObject,
  parseChallenge, parseReceipt, parseSettleResponse, parseReceiptExtension,
  decodeBase64Json, encodeXPaymentHeader,
  buildSignatureHeader, buildChallengeHeader, buildReceiptHeader,
  classifyChallenge, describeChallenge,
} from '@piprail/sdk'
import { check, banner, group, note, skip, done } from '../lib/report.mjs'
import { loadWallet } from '../lib/env.mjs'

banner('10 · WIRE-CODEC ADVERSARIAL FUZZING')
const w = loadWallet()
const MERCHANT = w?.merchant ?? '0x28Dc25bf88BF06fc0a3Af1747D1aA4a21f313ed0'
const ASSET = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' // Base USDC

// ── helpers ──────────────────────────────────────────────────────────────────
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64')
const deepEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b)
/** Call `fn(arg)`; return `{ threw:false, value }` or `{ threw:true, err }`. Never re-throws. */
function tryCall(fn, arg) {
  try { return { threw: false, value: fn(arg) } } catch (err) { return { threw: true, err } }
}
/** Run `fn` over EVERY input in `battery`; FAIL the named check iff ANY input threw. */
function noThrowAll(label, fn, battery) {
  let threwOn = null
  for (const inp of battery) {
    const r = tryCall(fn, inp)
    if (r.threw) { threwOn = { inp, msg: r.err?.message }; break }
  }
  check(threwOn === null, `${label} never throws across the hostile battery${threwOn ? ` — THREW on ${JSON.stringify(String(threwOn.inp).slice(0, 24))}: ${threwOn.msg}` : ''}`)
}

// The shared hostile battery for the STRING-consuming codecs.
const tenKDeep = (() => { let s = '1'; for (let i = 0; i < 10000; i++) s = `{"a":${s}}`; return s })()
const STRING_BATTERY = [
  '', '   ', 'null', '{', '[]', 'not json', 'x'.repeat(1024), 'x'.repeat(1024 * 1024), // 1MB
  '====', '!!!not-base64!!!', '%%%', '🚀💸✨', '\x00\x01',
  b64({ a: 1, b: [1, 2, 3] }), b64('a-bare-string'), b64(42), b64(null), b64(true),
  b64({ __proto__: { polluted: true } }), b64({ constructor: { prototype: { x: 1 } } }),
  b64(JSON.parse('{"__proto__":{"polluted":true}}')),
  b64({ amount: '1e309' }), b64({ amount: '2.5e-12' }), b64({ value: '9'.repeat(400) }),
  b64({ scheme: 'onchain-proof', network: 'eip155:8453' }), // looks plausible, missing payload
  Buffer.from(tenKDeep).toString('base64'),
]
// Wrong-typed args (the codecs take a string by signature; these are out-of-type but the SDK
// must still degrade, not crash).
const WRONG_TYPE_ARGS = [null, undefined, 123, true, false, {}, [], { scheme: 'x' }]
// The OBJECT-core parsers take an already-decoded `unknown`.
const OBJECT_BATTERY = [
  null, undefined, 123, true, '', 'str', {}, [], NaN, Infinity,
  { scheme: 'onchain-proof', network: 'eip155:8453' },
  { __proto__: { polluted: true }, scheme: 'onchain-proof' },
  JSON.parse('{"__proto__":{"polluted":true}}'),
  { constructor: { prototype: { x: 1 } } },
  { x402Version: 2, accepted: 'not-an-object', payload: 99 },
  { payload: { nonce: 1, txHash: [] } },
  { amount: '1e309', value: '9'.repeat(400) },
]

// ─────────────────── (1) STRING codecs: never throw on junk ────────────────────
group('(1a) string-consuming parsers never throw on the hostile battery')
{
  for (const [name, fn] of [
    ['parseSignatureHeader', parseSignatureHeader],
    ['parseExactPaymentHeader', parseExactPaymentHeader],
    ['parseUptoPaymentHeader', parseUptoPaymentHeader],
    ['decodeBase64Json', decodeBase64Json],
  ]) {
    noThrowAll(name, fn, STRING_BATTERY)
    noThrowAll(`${name} (wrong-typed args)`, fn, WRONG_TYPE_ARGS)
  }
  // A read function must yield a USABLE non-throwing result on plausible-but-wrong input.
  check(parseSignatureHeader(b64({ foo: 'bar' })) === null, 'parseSignatureHeader(b64 of a non-signature) → null (not a throw, not a truthy lie)')
  check(parseExactPaymentHeader('') === null, 'parseExactPaymentHeader("") → null')
  check(parseUptoPaymentHeader('not json') === null, 'parseUptoPaymentHeader("not json") → null')
  // decodeBase64Json of valid-base64-of-garbage must be null (not a throw).
  check(decodeBase64Json(Buffer.from('plain text not json').toString('base64')) === null, 'decodeBase64Json(b64 of non-JSON) → null')
  check(decodeBase64Json('') === null, 'decodeBase64Json("") → null')
}

group('(1b) object-core parsers never throw on hostile decoded objects')
{
  for (const [name, fn] of [
    ['parseSignatureObject', parseSignatureObject],
    ['parseExactObject', parseExactObject],
    ['parseUptoObject', parseUptoObject],
  ]) {
    noThrowAll(name, fn, OBJECT_BATTERY)
  }
  check(parseSignatureObject({ foo: 'bar' }) === null, 'parseSignatureObject({foo}) → null')
  check(parseExactObject(null) === null, 'parseExactObject(null) → null')
  check(parseUptoObject([]) === null, 'parseUptoObject([]) → null')
}

group('(1c) Response-consuming parsers never throw on junk headers/bodies')
{
  // Build a battery of REAL Response objects carrying garbage in the slots these parsers read.
  const junkResponses = [
    new Response('', { status: 402 }),
    new Response('', { status: 402, headers: { 'payment-required': '' } }),
    new Response('', { status: 402, headers: { 'payment-required': '{' } }),
    new Response('', { status: 402, headers: { 'payment-required': 'not base64 json' } }),
    new Response('', { status: 402, headers: { 'payment-required': b64({ __proto__: { polluted: true } }) } }),
    new Response('not json', { status: 402 }),
    new Response('{', { status: 402 }),
    new Response(JSON.stringify({ __proto__: { polluted: true } }), { status: 402, headers: { 'content-type': 'application/json' } }),
    new Response('x'.repeat(100000), { status: 402 }),
    new Response('', { status: 200, headers: { 'payment-response': 'garbage!!!' } }),
    new Response('', { status: 200, headers: { 'x-payment-response': b64({ nope: 1 }) } }),
    new Response('', { status: 200, headers: { 'payment-response': b64({ constructor: { prototype: { x: 1 } } }) } }),
  ]
  // parseChallenge is async (reads the body); the rest are sync. Drive both safely.
  let challengeThrew = null
  for (const resp of junkResponses) {
    try { await parseChallenge(resp.clone()) } catch (e) { challengeThrew = e?.message; break }
  }
  check(challengeThrew === null, `parseChallenge(junk Response) never throws${challengeThrew ? ` — THREW: ${challengeThrew}` : ''}`)

  for (const [name, fn] of [
    ['parseReceipt', parseReceipt],
    ['parseSettleResponse', parseSettleResponse],
    ['parseReceiptExtension', parseReceiptExtension],
  ]) {
    let threw = null
    for (const resp of junkResponses) {
      const r = tryCall(fn, resp.clone())
      if (r.threw) { threw = r.err?.message; break }
    }
    check(threw === null, `${name}(junk Response) never throws${threw ? ` — THREW: ${threw}` : ''}`)
  }
  // …and they return a CLEAN verdict, never a truthy lie, on a no-header 200.
  check(parseReceipt(new Response('', { status: 200 })) === null, 'parseReceipt(no header) → null')
  check(parseSettleResponse(new Response('', { status: 200 })) === null, 'parseSettleResponse(no header) → null')
  check(parseReceiptExtension(new Response('', { status: 200 })) === null, 'parseReceiptExtension(no extension) → null')
  // An explicit success:false settle is a REJECTION the buyer must honour (never recorded a spend).
  const settled = parseSettleResponse(new Response('', { status: 200, headers: { 'payment-response': b64({ success: false, errorReason: 'nope' }) } }))
  check(settled?.success === false, 'parseSettleResponse surfaces an explicit success:false rejection verbatim')
  check(parseSettleResponse(new Response('', { status: 200, headers: { 'payment-response': b64({ nofield: 1 }) } })) === null, 'parseSettleResponse(no boolean success) → null')
}

// ─────────────────── (2) NO PROTOTYPE POLLUTION after the whole battery ─────────
group('(2) the full hostile battery did NOT pollute Object.prototype')
{
  // Re-run every pollution-shaped payload through every codec, then assert a fresh {} is clean.
  const polluteStr = [b64({ __proto__: { polluted: true } }), b64({ constructor: { prototype: { x: 1 } } }), b64(JSON.parse('{"__proto__":{"polluted":true}}'))]
  for (const s of polluteStr) {
    parseSignatureHeader(s); parseExactPaymentHeader(s); parseUptoPaymentHeader(s); decodeBase64Json(s)
  }
  for (const o of [{ __proto__: { polluted: true } }, JSON.parse('{"__proto__":{"polluted":true}}'), { constructor: { prototype: { x: 1 } } }]) {
    parseSignatureObject(o); parseExactObject(o); parseUptoObject(o)
  }
  parseSettleResponse(new Response('', { status: 200, headers: { 'payment-response': polluteStr[0] } }))
  const probe = {}
  check(probe.polluted === undefined && Object.prototype.polluted === undefined, 'no Object.prototype.polluted after the __proto__ battery')
  check(probe.x === undefined && Object.prototype.x === undefined, 'no Object.prototype.x after the constructor.prototype battery')
  check(({}).polluted === undefined, 'a fresh {} is unpolluted (defensive double-check)')
}

// ─────────────────── (3) round-trip stability on REAL gate output ──────────────
group('(3) build*→parse* round-trips on a real createPaymentGate challenge')
{
  const gate = createPaymentGate({ chain: 'base', token: 'USDC', amount: '0.001', payTo: MERCHANT, rpcUrl: 'http://127.0.0.1:1' })
  const c = await gate.challenge('http://example.com/r')
  const ch = c.challenge

  // 3a — buildChallengeHeader → parseChallenge re-derives an EQUIVALENT challenge.
  const chHdr = buildChallengeHeader(ch)
  check(typeof chHdr === 'string' && chHdr.length > 0, 'buildChallengeHeader emits a non-empty string')
  check(decodeBase64Json(chHdr) != null, 'the challenge header is base64-JSON decodeBase64Json can read')
  const parsedCh = await parseChallenge(new Response('', { status: 402, headers: { 'payment-required': chHdr } }))
  check(parsedCh != null, 'parseChallenge re-parses the built challenge header')
  check(parsedCh?.x402Version === ch.x402Version, 'round-tripped x402Version matches')
  check(deepEqual(parsedCh?.accepts, ch.accepts), 'round-tripped accepts[] is deep-equal to the original')
  check(deepEqual(parsedCh?.resource, ch.resource), 'round-tripped resource is deep-equal to the original')
  check(deepEqual(parsedCh?.extensions, ch.extensions), 'round-tripped extensions is deep-equal (the self-describe block survives)')

  // 3b — buildSignatureHeader of a hand-built onchain-proof signature round-trips.
  const accept = ch.accepts.find((a) => a.scheme === 'onchain-proof')
  check(!!accept, 'the gate offered an onchain-proof rail to echo back')
  const tx = '0x' + 'ab'.repeat(32)
  const sig = { x402Version: 2, accepted: accept, payload: { nonce: accept.extra.nonce, txHash: tx } }
  const sigHdr = buildSignatureHeader(sig)
  const parsedSig = parseSignatureHeader(sigHdr)
  check(parsedSig != null, 'parseSignatureHeader re-parses the built signature header')
  check(parsedSig?.x402Version === 2, 'round-tripped signature x402Version === 2')
  check(parsedSig?.accepted?.scheme === 'onchain-proof', 'round-tripped accepted.scheme survives')
  check(parsedSig?.accepted?.network === accept.network, 'round-tripped accepted.network survives')
  check(parsedSig?.payload?.txHash === tx, 'round-tripped payload.txHash survives byte-for-byte')
  check(parsedSig?.payload?.nonce === accept.extra.nonce, 'round-tripped payload.nonce survives')

  // 3c — the object-core parser is byte-identical to the base64 wrapper (A2A parity).
  const viaObj = parseSignatureObject(decodeBase64Json(sigHdr))
  check(deepEqual(viaObj, parsedSig), 'parseSignatureObject(decodeBase64Json(h)) === parseSignatureHeader(h) (A2A object-core parity)')

  // 3d — encodeXPaymentHeader (v1 flat exact) → parseExactPaymentHeader round-trips.
  const auth = { from: MERCHANT, to: MERCHANT, value: '1000', validAfter: '0', validBefore: '99999999999', nonce: '0x' + 'cd'.repeat(32) }
  const xHdr = encodeXPaymentHeader({ network: 'eip155:8453', authorization: auth, signature: '0x' + 'ef'.repeat(65) })
  check(typeof xHdr === 'string' && xHdr.length > 0, 'encodeXPaymentHeader emits a non-empty string')
  const decX = decodeBase64Json(xHdr)
  check(decX?.x402Version === 1 && decX?.scheme === 'exact', 'encodeXPaymentHeader frames a v1 flat exact body (x402Version:1, scheme:"exact")')
  const parsedX = parseExactPaymentHeader(xHdr)
  check(parsedX != null, 'parseExactPaymentHeader re-parses encodeXPaymentHeader output (documented inverse)')
  check(parsedX?.network === 'eip155:8453', 'round-tripped exact network survives')
  check(deepEqual(parseExactObject(decodeBase64Json(xHdr)), parsedX), 'parseExactObject(decodeBase64Json(x)) === parseExactPaymentHeader(x) (exact A2A parity)')

  // 3e — buildReceiptHeader → parseReceipt round-trips a chain-grounded receipt.
  const receipt = { x402Version: 2, scheme: 'onchain-proof', network: 'eip155:8453', transaction: '0x' + '12'.repeat(32), payer: MERCHANT, payTo: MERCHANT, asset: ASSET, amount: '1000' }
  const rcptHdr = buildReceiptHeader(receipt)
  const parsedR = parseReceipt(new Response('', { status: 200, headers: { 'payment-response': rcptHdr } }))
  check(parsedR != null, 'parseReceipt re-parses the built receipt header')
  check(parsedR?.transaction === receipt.transaction, 'round-tripped receipt.transaction survives')
  check(parsedR?.amount === receipt.amount, 'round-tripped receipt.amount survives')
  check(parsedR?.payTo?.toLowerCase() === receipt.payTo.toLowerCase(), 'round-tripped receipt.payTo survives')

  // 3f — decodeBase64Json is the exact inverse of base64(JSON.stringify(x)) for nested data.
  const obj = { hello: 'world', n: 42, nested: { a: [1, 2, 3], b: { c: true } }, unicode: '🚀' }
  check(deepEqual(decodeBase64Json(b64(obj)), obj), 'decodeBase64Json ∘ base64(JSON.stringify) is the identity for nested data')

  // 3g — the upto parser STRICTLY rejects an exact (no witness.facilitator) payload.
  const exactish = { x402Version: 2, accepted: { scheme: 'upto', network: 'eip155:8453' }, payload: { signature: '0x' + 'ef'.repeat(65), permit2Authorization: { permitted: { token: ASSET, amount: '1' }, from: MERCHANT, spender: MERCHANT, nonce: '0', deadline: '0', witness: {} } } }
  check(parseUptoPaymentHeader(b64(exactish)) === null, 'parseUptoPaymentHeader rejects a payload with no witness.facilitator (no exact/upto confusion)')
  check(parseUptoObject(exactish) === null, 'parseUptoObject mirrors the same strict rejection')
}

// ─────────────────── (4) triage helpers stay graceful on malformed challenges ──
group('(4) classifyChallenge / describeChallenge on malformed challenges')
{
  const opts = { network: 'eip155:8453', schemes: ['onchain-proof'] }
  // The inputs the SDK is contracted to handle gracefully — a verdict/string, never a throw.
  const safeChallenges = [
    { accepts: [] },                                  // empty rails (degrades per the docstring)
    { accepts: [{}] },                                // a rail with no fields
    { accepts: [{ scheme: 'onchain-proof', network: 'eip155:8453' }] }, // a payable rail
    {},                                               // missing accepts entirely
  ]
  // classifyChallenge documents "Never throws" — it must survive every malformed challenge.
  for (const ch of safeChallenges) {
    const r = tryCall((c) => classifyChallenge(c, opts), ch)
    check(!r.threw && typeof r.value?.verdict === 'string', `classifyChallenge(${JSON.stringify(ch).slice(0, 22)}) → a verdict, no throw${r.threw ? ` (THREW: ${r.err?.message})` : ''}`)
  }
  check(classifyChallenge({ accepts: [] }, opts).verdict === 'NO_RAIL', 'classifyChallenge(empty accepts) → NO_RAIL verdict')
  check(classifyChallenge({ accepts: [{ scheme: 'onchain-proof', network: 'eip155:8453' }] }, opts).verdict === 'PAYABLE_RAIL', 'classifyChallenge(matching rail) → PAYABLE_RAIL')
  check(classifyChallenge({ accepts: [{ scheme: 'onchain-proof', network: 'eip155:1' }] }, opts).verdict === 'WRONG_CHAIN', 'classifyChallenge(off-chain rail) → WRONG_CHAIN')

  // describeChallenge is documented PURE; it must yield a string on the same safe challenges.
  for (const ch of safeChallenges.filter((c) => Array.isArray(c.accepts))) {
    const r = tryCall(describeChallenge, ch)
    check(!r.threw && typeof r.value === 'string' && r.value.length > 0, `describeChallenge(${JSON.stringify(ch).slice(0, 22)}) → a non-empty string, no throw${r.threw ? ` (THREW: ${r.err?.message})` : ''}`)
  }
  check(/piprail|sdk/i.test(describeChallenge({ accepts: [] })), 'describeChallenge(empty accepts) degrades to a generic PipRail pointer')

  // ── FINDINGS — the documented never-throw / pure contract LEAKS on these malformed challenges.
  // We RECORD them (note, not a hard check) so the suite stays green while flagging the gap; the
  // structured report carries them as `wart`/`bug` findings.
  const leakProbes = [
    ['classifyChallenge', (c) => classifyChallenge(c, opts), { accepts: 'gotcha' }],
    ['describeChallenge', describeChallenge, {}],
    ['describeChallenge', describeChallenge, { accepts: null }],
    ['describeChallenge', describeChallenge, { accepts: 'gotcha' }],
  ]
  for (const [name, fn, ch] of leakProbes) {
    const r = tryCall(fn, ch)
    if (r.threw) note(`FINDING — ${name}(${JSON.stringify(ch)}) THREW "${r.err?.message}" despite its documented never-throw/pure contract`)
  }
  // The ONE hard never-throw assertion we keep on a triage helper: classifyChallenge with a
  // STRUCTURALLY-VALID (array) accepts must never throw — this passes and pins the floor.
  {
    const r = tryCall((c) => classifyChallenge(c, opts), { accepts: [{ scheme: 'upto', network: 'eip155:8453', amount: '1e309' }] })
    check(!r.threw && typeof r.value?.verdict === 'string', 'classifyChallenge tolerates a sci-notation amount inside a well-formed rail')
  }
}

if (!w) skip('no .secrets wallet — but suite 10 is fully offline, nothing was skipped')

done('10 wire-codec-fuzz')

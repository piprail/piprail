// Suite 07 — payment-identifier idempotency extension  (NEW in @piprail/sdk@2.14.0)
//
// The standard x402 `payment-identifier` extension is an OPTIONAL idempotency `id` (16–128 chars
// [A-Za-z0-9_-]) a client attaches at `payload.extensions['payment-identifier'].info.id`. With
// `paymentIdentifier:true` the gate ADVERTISES it on every 402 and DEDUPES the id on its existing
// used-proof set (namespaced `pid:<id>`): a reused id is rejected `tx_already_used`, a malformed id
// is re-challenged `signature_invalid`, and the id is echoed on the settled PAYMENT-RESPONSE. The id
// is ADDITIVE to — never a replacement for — proof-set replay protection. Default OFF (byte-identical).
//
//   OFFLINE (always): the advert shape; the gate advertises iff the option is on; readPaymentIdentifier
//     validates the FULL matrix (length, charset, type, absence) and NEVER throws / never pollutes.
//   LIVE (Base mainnet, tiny USDC — only with .secrets + PIPRAIL_LIVE=1):
//     mint a real onchain-proof, inject a valid id → settle + the id is ECHOED; REPLAY the same proof
//     → tx_already_used; mint a SECOND, fresh proof with the SAME id → rejected by the PID DEDUPE
//     (the tx is new, only `pid:<id>` is used — proves it's not mere tx-replay); a malformed id on a
//     fresh proof → signature_invalid re-challenge.
//
import {
  createPaymentGate, PipRailClient,
  buildPaymentIdentifierAdvertisement, readPaymentIdentifier, EXT_PAYMENT_IDENTIFIER,
  buildSelfDescription, decodeBase64Json,
} from '@piprail/sdk'
import { check, banner, group, note, skip, done } from '../lib/report.mjs'
import { loadWallet, RPC } from '../lib/env.mjs'
import { serveGate } from '../lib/http-gate.mjs'

banner('07 · payment-identifier idempotency (NEW 2.14.0)')
const w = loadWallet()
const MERCHANT = w?.merchant ?? '0x28Dc25bf88BF06fc0a3Af1747D1aA4a21f313ed0'

// A reader the SDK contracts as never-throw: a throw FAILS the suite rather than escaping it.
const readNoThrow = (payload, label) => {
  try { return { ok: true, val: readPaymentIdentifier(payload) } }
  catch (err) { check(false, `readPaymentIdentifier ${label} THREW (${err?.message ?? err}) — must never throw`); return { ok: false } }
}
const withId = (id) => ({ extensions: { [EXT_PAYMENT_IDENTIFIER]: { info: { id } } } })

// ───────────────────────── the constant + advertisement ─────────────────────────
group('offline — the extension key + advertisement shape')
{
  check(EXT_PAYMENT_IDENTIFIER === 'payment-identifier', 'EXT_PAYMENT_IDENTIFIER === "payment-identifier" (the spec key)')
  let advert
  try { advert = buildPaymentIdentifierAdvertisement() } catch (e) { check(false, `buildPaymentIdentifierAdvertisement threw: ${e.message}`) }
  check(advert && typeof advert === 'object', 'buildPaymentIdentifierAdvertisement() → an object')
  const blk = advert?.[EXT_PAYMENT_IDENTIFIER]
  check(!!blk, 'the advert is keyed by the extension name')
  check(blk?.info?.required === false, 'the extension is advertised as OPTIONAL (info.required === false)')
  const idSchema = blk?.schema?.properties?.id
  check(idSchema?.type === 'string' && idSchema?.minLength === 16 && idSchema?.maxLength === 128,
    'the advert publishes the id JSON-Schema (string, 16–128) so a client knows the rule before paying')
  check(JSON.stringify(advert).length > 0, 'the advert is JSON-serializable')
}

// ───────────────────────── default OFF / opt-in ON ─────────────────────────
group('offline — paymentIdentifier:true advertises the extension; default OFF is byte-identical (minus nonce)')
{
  const on = createPaymentGate({ chain: 'base', token: 'USDC', amount: '0.001', payTo: MERCHANT, rpcUrl: RPC, paymentIdentifier: true })
  const off = createPaymentGate({ chain: 'base', token: 'USDC', amount: '0.001', payTo: MERCHANT, rpcUrl: RPC })
  const cOn = (await on.challenge('http://127.0.0.1:1/r')).challenge
  const cOff = (await off.challenge('http://127.0.0.1:1/r')).challenge
  check(!!cOn.extensions?.[EXT_PAYMENT_IDENTIFIER], 'paymentIdentifier:true → the 402 advertises extensions["payment-identifier"]')
  check(!cOff.extensions?.[EXT_PAYMENT_IDENTIFIER], 'default gate does NOT advertise the extension (opt-in)')

  // "Default off → byte-identical" minus the volatile nonce + the added extension key.
  const strip = (c) => {
    const accepts = (c.accepts ?? []).map((a) => { const { extra, ...rest } = a; const { nonce, ...ex } = extra ?? {}; return { ...rest, extra: ex } })
    const { [EXT_PAYMENT_IDENTIFIER]: _omit, ...exts } = c.extensions ?? {}
    return JSON.stringify({ ...c, accepts, extensions: exts })
  }
  check(strip(cOn) === strip(cOff), 'turning the extension ON changes ONLY the advertised extension + the nonce (no other drift)')

  // The advertised id-rule on the wire equals the standalone advertisement.
  check(JSON.stringify(cOn.extensions[EXT_PAYMENT_IDENTIFIER]) === JSON.stringify(buildPaymentIdentifierAdvertisement()[EXT_PAYMENT_IDENTIFIER]),
    'the on-wire advert === buildPaymentIdentifierAdvertisement() (one source of truth)')

  // A self-describe still works alongside it.
  const sd = buildSelfDescription({ accepts: cOn.accepts })
  check(!!sd, 'buildSelfDescription composes with an id-advertising challenge')
}

// ───────────────────────── readPaymentIdentifier — the FULL validation matrix ─────────────────────────
group('offline — readPaymentIdentifier: accepts ONLY strictly-valid ids, never throws, never pollutes')
{
  // VALID — returns the id string verbatim.
  for (const [label, id] of [['16-char min', 'a'.repeat(16)], ['128-char max', 'a'.repeat(128)], ['full charset', 'aZ09_-aZ09_-aZ09_']]) {
    const r = readNoThrow(withId(id), label)
    if (r.ok) check(r.val === id, `valid id (${label}) → returned verbatim`)
  }
  // INVALID-LENGTH — returns an { invalid } verdict object (NOT the id, NOT null).
  for (const [label, id] of [['15-char (one short)', 'a'.repeat(15)], ['129-char (one long)', 'a'.repeat(129)]]) {
    const r = readNoThrow(withId(id), label)
    if (r.ok) check(r.val && typeof r.val === 'object' && /16.*128|chars/.test(r.val.invalid ?? ''), `length-invalid id (${label}) → { invalid } verdict`)
  }
  // INVALID-CHARSET — space, dot, slash, unicode, emoji (all length-valid).
  for (const [label, id] of [['space', 'abc def ghij klmno'], ['dot', 'abc.def.ghij.klmn'], ['slash', 'abc/def/ghij/klmn'], ['unicode', 'abcdéfghijklmnop1'], ['emoji', 'abcd😀fghijklmnop1']]) {
    const r = readNoThrow(withId(id), label)
    if (r.ok) check(r.val && typeof r.val === 'object' && /A-Za-z0-9_-|match/.test(r.val.invalid ?? ''), `charset-invalid id (${label}) → { invalid } verdict, not accepted`)
  }
  // WRONG TYPE — number / array / object id → { invalid: must be a string }.
  for (const [label, id] of [['number', 123456789012345678], ['array', ['a'.repeat(16)]], ['object', { id: 'x' }], ['true', true]]) {
    const r = readNoThrow(withId(id), label)
    if (r.ok) check(r.val && typeof r.val === 'object' && /string/.test(r.val.invalid ?? ''), `non-string id (${label}) → { invalid: must be a string }`)
  }
  // ABSENT — null/undefined/empty/no-extension/ext-not-object → null (no id present, NOT an error).
  for (const [label, payload] of [['null payload', null], ['undefined payload', undefined], ['{} payload', {}], ['no extensions', { foo: 1 }], ['ext is a string', { extensions: { [EXT_PAYMENT_IDENTIFIER]: 'x' } }], ['empty info', { extensions: { [EXT_PAYMENT_IDENTIFIER]: {} } }], ['empty-string id', withId('')]]) {
    const r = readNoThrow(payload, label)
    if (r.ok) check(r.val === null || (typeof r.val === 'object' && 'invalid' in r.val), `absent/empty id (${label}) → null or { invalid } (never a thrown error)`)
  }
}

group('offline — prototype-pollution & hostile structure cannot poison Object.prototype')
{
  const hostile = [
    { extensions: { [EXT_PAYMENT_IDENTIFIER]: { info: { id: '__proto__' } } } },
    JSON.parse('{"extensions":{"payment-identifier":{"info":{"id":"__proto__"}}},"__proto__":{"polluted":true}}'),
    JSON.parse('{"extensions":{"payment-identifier":{"__proto__":{"info":{"id":"aaaaaaaaaaaaaaaa"}}}}}'),
    { extensions: { [EXT_PAYMENT_IDENTIFIER]: { info: { id: 'constructor'.padEnd(16, 'x') } } } },
  ]
  let threw = false
  for (const h of hostile) { try { readPaymentIdentifier(h) } catch { threw = true } }
  check(threw === false, 'readPaymentIdentifier never throws across prototype-pollution payloads')
  check(({}).polluted === undefined, 'Object.prototype.polluted was NOT set (no prototype pollution)')
  check(({}).info === undefined, 'Object.prototype was not otherwise poisoned')
  // "__proto__" as a literal id is 9 chars → it must be rejected on LENGTH, never treated specially.
  const r = readPaymentIdentifier(withId('__proto__'))
  check(r && typeof r === 'object' && 'invalid' in r, 'a literal "__proto__" id is rejected as a normal too-short id')
}

// ───────────────────────── LIVE — gate dedupe on Base mainnet ─────────────────────────
const LIVE = w && process.env.PIPRAIL_LIVE === '1'
if (!LIVE) {
  skip('no .secrets wallet or PIPRAIL_LIVE!=1 → skipping the live Base-mainnet pid dedupe round-trip')
} else {
  group('live — settle a real payment WITH an id → echo; replay; FRESH proof + same id → pid dedupe; malformed id')

  const ID_A = 'pidLIVE_' + 'a'.repeat(16) // 24 chars, valid charset
  let captured = null
  // The gate under test. onVerify CAPTURES the client's signature WITHOUT consuming the gate, so we
  // can inject a payment-identifier into the decoded payload and drive gate.verifyObject ourselves —
  // exactly how an interop client that DOES attach the standard extension would be handled.
  const gate = createPaymentGate({ chain: 'base', token: 'USDC', amount: '0.001', payTo: w.merchant, rpcUrl: RPC, paymentIdentifier: true })
  const srv = serveGate(gate, { port: 4871, path: '/pid', body: { ok: true }, onVerify: (sig) => { captured = sig; return { kind: 'paid' } } })
  await srv.listen()

  /** Broadcast one real onchain-proof payment and return its decoded signature envelope
   *  { x402Version, accepted, payload } (not yet consumed). The payment-identifier rides at the
   *  envelope's TOP-LEVEL `extensions` (a sibling of accepted/payload — where readPaymentIdentifier
   *  reads it), NOT inside `payload`. The onchain-proof hash field is `payload.txHash`. */
  async function mintProof() {
    captured = null
    const buyer = new PipRailClient({ chain: 'base', wallet: { key: w.key }, rpcUrl: RPC })
    const res = await buyer.fetch(srv.url)
    if (res.status !== 200) throw new Error('mint fetch did not reach 200')
    const decoded = decodeBase64Json(captured)
    if (!decoded?.payload?.txHash) throw new Error('could not decode the minted signature (no payload.txHash)')
    return decoded
  }
  const tag = (sig, id) => ({ ...sig, extensions: { [EXT_PAYMENT_IDENTIFIER]: { info: { id } } } })
  /** Echo-scan: does the settled PAYMENT-RESPONSE carry the id back? */
  const echoes = (verdict, id) => {
    const blob = JSON.stringify(verdict ?? {}) + (verdict?.receiptHeader ? JSON.stringify(decodeBase64Json(verdict.receiptHeader) ?? {}) : '')
    return blob.includes(id)
  }

  try {
    // (1) real proof #1 + a VALID id → settles, id echoed.
    note('minting real proof #1 (broadcasts a tiny Base USDC tx) …')
    const p1 = await mintProof()
    const v1 = await gate.verifyObject(tag(p1, ID_A))
    check(v1.kind === 'paid', 'a real onchain-proof carrying a valid payment-identifier SETTLES (kind:paid)')
    check(echoes(v1, ID_A), 'the settled PAYMENT-RESPONSE ECHOES the payment-identifier id back')

    // (2) replay the SAME object → single-use.
    const v1b = await gate.verifyObject(tag(p1, ID_A))
    check(v1b.kind === 'invalid' && v1b.error === 'tx_already_used', 'replaying the identical proof is rejected (tx_already_used)')

    // (3) a SECOND, FRESH proof (new tx) with the SAME id → rejected by the PID dedupe, not tx-replay.
    note('minting real proof #2 (a DISTINCT tx) reusing the same id …')
    const p2 = await mintProof()
    check(p2.payload.txHash !== p1.payload.txHash, 'proof #2 is a genuinely different transaction')
    const v2 = await gate.verifyObject(tag(p2, ID_A))
    check(v2.kind === 'invalid' && v2.error === 'tx_already_used',
      'a FRESH tx reusing an already-seen id is rejected by the PID dedupe (proves it is not mere tx-replay)')

    // (4) a fresh proof with a MALFORMED id → signature_invalid re-challenge (not tx_already_used).
    note('minting real proof #3 with a malformed id …')
    const p3 = await mintProof()
    const v3 = await gate.verifyObject(tag(p3, 'too-short')) // 9 chars → invalid
    check(v3.kind === 'invalid', 'a malformed payment-identifier is rejected, never settled')
    check(v3.error === 'signature_invalid', 'a malformed id re-challenges as signature_invalid (the documented verdict)')
    // and the fresh proof p3 was NOT consumed by the rejected attempt → it still settles with no id.
    const v3b = await gate.verifyObject(p3)
    check(v3b.kind === 'paid', 'the proof rejected ONLY for a bad id is not burned — it settles when re-presented without the id')

    // (5) a fresh proof with NO id still settles (the extension is purely additive).
    note('minting real proof #4 with NO id (additive-only check) …')
    const p4 = await mintProof()
    const v4 = await gate.verifyObject(p4)
    check(v4.kind === 'paid', 'a payment with NO id settles exactly as before (the extension is additive, never required)')
  } catch (err) {
    check(false, `live pid round-trip threw: ${err?.message ?? err}`)
  } finally {
    srv.close()
  }
}

done(LIVE ? '07 payment-identifier' : '07 payment-identifier (offline)')

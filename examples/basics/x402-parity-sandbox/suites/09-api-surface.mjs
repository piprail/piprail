// Suite 09 — PUBLISHED-ARTIFACT API SURFACE + package hygiene guard
//
// `npm i @piprail/sdk` has to actually SHIP the whole advertised API — every named export the
// docs/types promise, with the RIGHT typeof, reachable from BOTH the ESM and the CJS entry, plus
// the `/node` subpath. This suite is the contract: if a refactor silently drops or mistypes an
// export, or the exports map regresses, it goes red here.
//
//   OFFLINE (always — this whole suite is wallet-free):
//     (1) ≥140 named exports; a curated ~60 critical ones each have the right typeof.
//     (2) no named export is `undefined`.
//     (3) the `/node` subpath resolves and `fileSpendStore` is a function.
//     (4) the CJS entry resolves and yields the SAME export-name set as ESM (no skew).
//     (5) WART: `@piprail/sdk/package.json` is NOT in the exports map → import throws
//         ERR_PACKAGE_PATH_NOT_EXPORTED (asserted + flagged a wart).
//     (6) the shipped types (`dist/index.d.ts`) exist in node_modules.
//     (7) every error class news to an `instanceof PipRailError` (subclasses also carry a stable
//         string `.code`); the curated never-throw read methods return a verdict on hostile input.
//
import { readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import * as sdk from '@piprail/sdk'
import { check, banner, group, note, skip, done } from '../lib/report.mjs'
import { loadWallet } from '../lib/env.mjs'

banner('09 · PUBLISHED API SURFACE + PACKAGE HYGIENE')
const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

// A Response-like shim so the in-contract never-throw checks for parseChallenge don't touch a
// real socket — parseChallenge(response: Response) reads response.headers.get(...) + .json().
const mkResp = (hdrs = {}, body = null) => ({
  status: 402,
  headers: { get: (k) => hdrs[k] ?? hdrs[k?.toLowerCase?.()] ?? null },
  json: async () => body,
  text: async () => (body == null ? '' : JSON.stringify(body)),
})

// ───────────────────────── (1) EXPORT COUNT ─────────────────────────
group('the published package ships its whole advertised API (≥140 named exports)')
{
  const names = Object.keys(sdk).filter((k) => k !== 'default')
  note(`@piprail/sdk exposes ${names.length} named exports`)
  check(names.length >= 140, `≥140 named exports (got ${names.length})`)
  // No export may be undefined (a broken re-export shows up as a present-but-undefined key).
  const undef = names.filter((n) => sdk[n] === undefined)
  check(undef.length === 0, `no named export is undefined (offenders: ${undef.join(', ') || 'none'})`)
}

// ───────────────────────── (1b) CURATED TYPEOF MATRIX ─────────────────────────
// Each tuple is [exportName, expectedTypeof, optionalArrayFlag]. typeof of a class is 'function'.
group('a curated ~60 critical exports each have the RIGHT typeof')
{
  // Factories / helpers / codecs — all functions.
  const FUNCS = [
    'createPaymentGate', 'requirePayment', 'PipRailClient', 'createMcpPaymentTool',
    'createA2APaymentHandler', 'buildWellKnownX402Manifest', 'buildPaymentIdentifierAdvertisement',
    'readPaymentIdentifier', 'evaluatePolicy', 'planAcross', 'fetchAcross', 'normalizeNetwork',
    'resolveChain', 'decodeBase64Json', 'parseChallenge', 'encodeXPaymentHeader', 'buildSelfDescription',
  ]
  for (const n of FUNCS) check(typeof sdk[n] === 'function', `${n} is a function (got ${typeof sdk[n]})`)

  // Objects / constants.
  const OBJS = ['CHAINS', 'BUILTIN_DENOMS', 'KNOWN_FACILITATORS', 'DIRECTORY_INFO', 'EIP3009_TYPES']
  for (const n of OBJS) {
    check(typeof sdk[n] === 'object' && sdk[n] !== null, `${n} is a non-null object (got ${typeof sdk[n]})`)
  }
  // Sharper shape probes on the consts.
  check('base' in (sdk.CHAINS ?? {}) && Object.keys(sdk.CHAINS).length >= 10, 'CHAINS is a non-empty preset map keyed by chain name (has "base")')
  check(typeof sdk.BUILTIN_DENOMS?.USDC === 'string', 'BUILTIN_DENOMS maps token symbols → fiat denom (USDC present)')
  check('TransferWithAuthorization' in (sdk.EIP3009_TYPES ?? {}), 'EIP3009_TYPES carries the TransferWithAuthorization typed-data')
  check(Object.keys(sdk.KNOWN_FACILITATORS ?? {}).length >= 1, 'KNOWN_FACILITATORS is a non-empty facilitator map')
  check(typeof sdk.DIRECTORY_INFO?.x402scan === 'object' || typeof sdk.DIRECTORY_INFO?.x402scan === 'string', 'DIRECTORY_INFO describes the open directories (x402scan present)')

  // Strings / string-ish constants. NOTE: BRAND ships as an OBJECT, not a string (see finding).
  const STRINGS = [
    'GENERATOR', 'POWERED_BY', 'HEADER_SIGNATURE', 'HEADER_REQUIRED', 'HEADER_RESPONSE',
    'EXT_PAYMENT_IDENTIFIER', 'EXT_OFFER_RECEIPT', 'MCP_PAYMENT_META_KEY', 'PERMIT2_ADDRESS',
    'PIPRAIL_AGENT_GUIDE',
  ]
  for (const n of STRINGS) check(typeof sdk[n] === 'string' && sdk[n].length > 0, `${n} is a non-empty string`)
  // BRAND — the task's curated list calls it a string, but the artifact ships it as an object.
  // Assert the TRUTH (object with name 'PipRail'), so the suite documents the real surface.
  check(typeof sdk.BRAND === 'object' && sdk.BRAND?.name === 'PipRail',
    "BRAND is an OBJECT { name:'PipRail', … } (NOT a string — task's curated list is stale on this)")
  // The header/ext constants must be the canonical wire values, not placeholders.
  check(sdk.HEADER_SIGNATURE === 'payment-signature', 'HEADER_SIGNATURE === "payment-signature"')
  check(sdk.HEADER_REQUIRED === 'payment-required', 'HEADER_REQUIRED === "payment-required"')
  check(sdk.HEADER_RESPONSE === 'payment-response', 'HEADER_RESPONSE === "payment-response"')
  check(sdk.PERMIT2_ADDRESS === '0x000000000022D473030F116dDEE9F6B43aC78BA3', 'PERMIT2_ADDRESS is the canonical Permit2 singleton')
}

// ───────────────────────── (1c) ERROR-CLASS MATRIX ─────────────────────────
group('every advertised error class is present, news clean, and is instanceof PipRailError')
{
  const { PipRailError } = sdk
  check(typeof PipRailError === 'function', 'PipRailError base class is exported')

  // Subclasses: each must new() into an `instanceof PipRailError` (and Error) AND carry a stable
  // string `.code`. The base PipRailError is intentionally excluded from the `.code` assertion.
  const SUBCLASSES = [
    'InsufficientFundsError', 'UnknownTokenError', 'WrongFamilyError', 'UnsupportedNetworkError',
    'WrongChainError', 'UnsupportedSchemeError', 'WalletRequiredError', 'RecipientNotReadyError',
    'MaxRetriesExceededError', 'PaymentDeclinedError', 'SettlementError', 'NoCompatibleAcceptError',
    'ConfirmationTimeoutError', 'NonReplayableBodyError', 'InvalidEnvelopeError', 'MissingDriverError',
    'PaymentTimeoutError',
  ]
  for (const n of SUBCLASSES) {
    const Cls = sdk[n]
    check(typeof Cls === 'function', `${n} is exported (a constructor)`)
    let inst, threw = false
    try { inst = new Cls('break-it') } catch { threw = true }
    check(!threw, `new ${n}('…') does not throw`)
    check(inst instanceof Error, `${n} extends Error`)
    check(inst instanceof PipRailError, `${n} is instanceof PipRailError (one stable catch)`)
    check(typeof inst?.code === 'string' && inst.code.length > 0, `${n} carries a stable string .code (${inst?.code})`)
  }

  // The base PipRailError itself: instanceof Error, name === 'PipRailError'. FINDING: the base
  // class news with `.code === undefined` — only the SUBCLASSES carry a stable `.code`. So a
  // generic `new PipRailError(msg)` (or a thrown anonymous-subclass that forgot a code) has no
  // machine-readable code, weakening the "every PipRailError has a .code" promise.
  {
    let base
    try { base = new PipRailError('plain') } catch { base = null }
    check(base instanceof Error && base?.name === 'PipRailError', 'new PipRailError(msg) is a named Error')
    check(base?.code === undefined, 'WART: base PipRailError has NO .code (undefined) — only subclasses set a stable code')
  }

  // MultiChainPayer + SpendLedger are exported classes (constructors), not errors.
  check(typeof sdk.MultiChainPayer === 'function', 'MultiChainPayer is an exported class')
  check(typeof sdk.SpendLedger === 'function', 'SpendLedger is an exported class')
}

// ───────────────────────── (3) /node SUBPATH ─────────────────────────
group('the /node subpath ships the file-backed spend store')
{
  let nodeMod, threw = false
  try { nodeMod = await import('@piprail/sdk/node') } catch (e) { threw = true; note(`/node import threw: ${e?.message}`) }
  check(!threw, '@piprail/sdk/node imports without throwing')
  check(typeof nodeMod?.fileSpendStore === 'function', '/node exports fileSpendStore (a function)')
  // memorySpendStore is also re-exported there per the published surface.
  check(typeof nodeMod?.memorySpendStore === 'function', '/node also re-exports memorySpendStore')
}

// ───────────────────────── (4) CJS PARITY ─────────────────────────
group('the CommonJS entry resolves and exposes the SAME export-name set as ESM')
{
  let cjsPath, threw = false
  try { cjsPath = require.resolve('@piprail/sdk') } catch (e) { threw = true; note(`require.resolve threw: ${e?.message}`) }
  check(!threw && typeof cjsPath === 'string', 'require.resolve("@piprail/sdk") resolves to a CJS entry')
  check(cjsPath?.includes('/x402-parity-sandbox/node_modules/'), 'CJS entry resolves to the PUBLISHED sandbox copy, not the workspace')

  let cjs, cjsThrew = false
  try { cjs = require('@piprail/sdk') } catch (e) { cjsThrew = true; note(`require() threw: ${e?.message}`) }
  check(!cjsThrew, 'require("@piprail/sdk") loads without throwing')

  const esmNames = new Set(Object.keys(sdk).filter((k) => k !== 'default'))
  const cjsNames = new Set(Object.keys(cjs ?? {}).filter((k) => k !== 'default'))
  const onlyEsm = [...esmNames].filter((n) => !cjsNames.has(n))
  const onlyCjs = [...cjsNames].filter((n) => !esmNames.has(n))
  check(cjsNames.size >= 140, `the CJS entry also exposes ≥140 named exports (got ${cjsNames.size})`)
  check(onlyEsm.length === 0, `no export is ESM-only (offenders: ${onlyEsm.join(', ') || 'none'})`)
  check(onlyCjs.length === 0, `no export is CJS-only (offenders: ${onlyCjs.join(', ') || 'none'})`)
  // A spot-check that a critical class is actually a constructor through the CJS path too.
  check(typeof cjs?.PipRailClient === 'function' && typeof cjs?.createPaymentGate === 'function', 'CJS PipRailClient + createPaymentGate are callable (not just present)')
}

// ───────────────────────── (5) PACKAGE.JSON SUBPATH WART ─────────────────────────
group('package hygiene: the exports map exposes ./package.json (F-D3, fixed in 2.14.1)')
{
  // 2.14.1 (F-D3): the exports map now includes "./package.json": "./package.json", so
  // version-introspection tooling can read it instead of hitting ERR_PACKAGE_PATH_NOT_EXPORTED.
  let pkg = null, threw = false
  try { pkg = require('@piprail/sdk/package.json') } catch { threw = true }
  check(!threw, 'require("@piprail/sdk/package.json") resolves (no ERR_PACKAGE_PATH_NOT_EXPORTED)')
  check(pkg?.name === '@piprail/sdk' && typeof pkg?.version === 'string', 'it returns the real package.json (name + version readable)')
}

// ───────────────────────── (6) SHIPPED TYPES ─────────────────────────
group('the published artifact ships its TypeScript types')
{
  const sdkRoot = resolve(require.resolve('@piprail/sdk'), '..', '..') // …/@piprail/sdk
  const dts = resolve(sdkRoot, 'dist', 'index.d.ts')
  const cdts = resolve(sdkRoot, 'dist', 'index.d.cts')
  const nodeDts = resolve(sdkRoot, 'dist', 'node.d.ts')
  check(existsSync(dts), 'dist/index.d.ts ships (ESM types reachable)')
  check(existsSync(cdts), 'dist/index.d.cts ships (CJS types reachable)')
  check(existsSync(nodeDts), 'dist/node.d.ts ships (the /node subpath has types too)')
  // The types file must actually be populated (a 0-byte stub would still "exist").
  let bytes = 0
  try { bytes = readFileSync(dts).length } catch { /* counted as 0 */ }
  check(bytes > 1000, `dist/index.d.ts is non-trivially populated (${bytes} bytes)`)
}

// ───────────────────────── (7) NEVER-THROW READ/CODEC CONTRACT ─────────────────────────
// The curated parse*/read methods must RETURN a verdict/null on hostile input, never throw.
group('the curated never-throw codecs/read methods absorb hostile input (return, never throw)')
{
  // decodeBase64Json(value: string) — junk in → null out.
  let r, threw
  threw = false
  try { r = sdk.decodeBase64Json('@@not-base64@@') } catch { threw = true }
  check(!threw && r === null, 'decodeBase64Json(junk) → null (never throws)')
  threw = false
  try { r = sdk.decodeBase64Json('') } catch { threw = true }
  check(!threw, 'decodeBase64Json("") does not throw')

  // parseChallenge(response: Response) — an in-contract Response with empty/junk headers → null.
  threw = false
  try { r = await sdk.parseChallenge(mkResp({}, null)) } catch { threw = true }
  check(!threw && r === null, 'parseChallenge(emptyResponse) → null (never throws on a malformed-but-in-type Response)')
  threw = false
  try { r = await sdk.parseChallenge(mkResp({ 'payment-required': 'not-json{' }, null)) } catch { threw = true }
  check(!threw, 'parseChallenge(Response with a non-JSON payment-required header) does not throw')

  // readPaymentIdentifier — hostile shapes → null, never throws.
  for (const bad of [{}, null, 'junk', 42, []]) {
    threw = false
    try { r = sdk.readPaymentIdentifier(bad) } catch { threw = true }
    check(!threw, `readPaymentIdentifier(${JSON.stringify(bad)}) does not throw`)
  }

  // evaluatePolicy — hostile intent/policy → a structured decision, never throws.
  threw = false
  try { r = sdk.evaluatePolicy({}, {}) } catch { threw = true }
  check(!threw && r && typeof r.allowed === 'boolean', 'evaluatePolicy({},{}) → { allowed:boolean } (never throws)')

  // encodeXPaymentHeader — empty input still returns a string (round-trips through decodeBase64Json).
  threw = false
  try { r = sdk.encodeXPaymentHeader({}) } catch { threw = true }
  check(!threw && typeof r === 'string' && r.length > 0, 'encodeXPaymentHeader({}) → a base64 string (never throws)')
  if (typeof r === 'string') {
    let back, rt = false
    try { back = sdk.decodeBase64Json(r) } catch { rt = true }
    check(!rt && back && typeof back === 'object', 'the encoded x-payment header decodes back to an object (encode↔decode round-trip)')
  }

  // normalizeNetwork — the HAPPY path is exact; FINDING: an off-type number crashes it.
  threw = false
  try { r = sdk.normalizeNetwork('base') } catch { threw = true }
  check(!threw && r === 'eip155:8453', 'normalizeNetwork("base") → "eip155:8453"')
  // A hostile non-string argument: per the .d.ts it is string-typed, but a JS caller passing a
  // number gets an UNGUARDED TypeError ("network.includes is not a function"), not a clean throw.
  {
    let numThrew = false, msg = ''
    try { sdk.normalizeNetwork(8453) } catch (e) { numThrew = true; msg = e?.message ?? '' }
    check(numThrew && /includes is not a function|not a function/.test(msg),
      'NOTE: normalizeNetwork(number) throws a raw TypeError (no input-type guard) — off-contract but ungraceful')
  }
}

// ───────────────────────── LIVE (none here) ─────────────────────────
// This suite is entirely static-surface; there is no on-chain leg. Note the wallet state only.
if (loadWallet() === null || process.env.PIPRAIL_LIVE !== '1') {
  skip('no live leg in the API-surface suite (it is wallet-free and money-free by design)')
}

done('09 api-surface')

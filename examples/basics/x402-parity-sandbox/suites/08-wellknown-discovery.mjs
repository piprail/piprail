// Suite 08 — .well-known/x402.json MANIFEST + the discovery-doc surface  (break-it, OFFLINE)
//
// The new buildWellKnownX402Manifest() emits the x402-v2 `.well-known/x402.json` directory
// document; the rest of the surface (buildWellKnownX402 v1, buildOpenApi, buildBazaarExtension,
// buildX402DnsTxt, DIRECTORY_INFO/getDirectoryInfo, GENERATOR, scoreResource/rankResources,
// searchOpenIndexes) describes a merchant's x402 resources to humans, agents, and crawlers.
//
// This suite is ENTIRELY OFFLINE — every builder is a pure function and discovery reads are
// network-tolerant. We feed each one well-formed, edge, and HOSTILE input and assert:
//   • the happy-path shape is exactly right (x402Version:2, lastUpdated is an int, items map 1:1);
//   • passing `lastUpdated` makes the manifest DETERMINISTIC (byte-identical JSON);
//   • attribution:false strips the x-generator marker (default stamps GENERATOR);
//   • extra/unknown input fields are tolerated (forward-compat), not thrown on;
//   • the contracted never-throw read (searchOpenIndexes) returns a verdict/array, never throws;
//   • every output is JSON-serializable (no bigint, no cycles);
//   • on TRULY malformed input the pure builders either return a well-formed object OR throw a
//     plain Error — but NEVER produce a NaN lastUpdated or a corrupt half-built object.
//
import {
  buildWellKnownX402Manifest, buildWellKnownX402, buildOpenApi, buildBazaarExtension,
  buildX402DnsTxt, getDirectoryInfo, DIRECTORY_INFO, GENERATOR,
  scoreResource, rankResources, searchOpenIndexes,
} from '@piprail/sdk'
import { check, banner, group, note, skip, done } from '../lib/report.mjs'
import { loadWallet } from '../lib/env.mjs'

banner('08 · .well-known/x402 MANIFEST + discovery surface')
const w = loadWallet()
const MERCHANT = w?.merchant ?? '0x28Dc25bf88BF06fc0a3Af1747D1aA4a21f313ed0'

// A reusable accepts array — the shape a real onchain-proof 402 advertises.
const ACCEPTS = [{ scheme: 'onchain-proof', network: 'eip155:8453', maxAmountRequired: '1000', payTo: MERCHANT, asset: 'USDC' }]
const isSerializable = (o) => { try { JSON.parse(JSON.stringify(o)); return true } catch { return false } }

// ───────────────────────── manifest: happy-path shape ─────────────────────────
group('manifest — x402Version:2, lastUpdated is an int, items map 1:1 with resources')
{
  const input = {
    origin: 'https://shop.example',
    title: 'Shop x402',
    resources: [
      { url: 'https://shop.example/a', accepts: ACCEPTS, description: 'Resource A', method: 'post', mimeType: 'application/json' },
      { url: 'https://shop.example/b', accepts: ACCEPTS },
    ],
  }
  let man
  try { man = buildWellKnownX402Manifest(input) } catch (e) { check(false, `buildWellKnownX402Manifest threw on a valid input: ${e?.message}`) }
  check(man?.x402Version === 2, 'manifest.x402Version === 2 (the v2 directory document)')
  check(typeof man?.lastUpdated === 'number' && Number.isSafeInteger(man.lastUpdated) && man.lastUpdated > 0, 'lastUpdated is a positive safe integer (unix seconds), not NaN/float')
  check(Array.isArray(man?.items) && man.items.length === 2, 'items.length === resources.length (2)')

  const it0 = man.items[0]
  check(it0?.resource?.url === 'https://shop.example/a', 'item[0].resource.url carried through')
  check(it0?.resource?.description === 'Resource A', 'item[0].resource.description carried through')
  check(it0?.resource?.mimeType === 'application/json', 'item[0].resource.mimeType carried through')
  check(it0?.type === 'http', "item[0].type === 'http'")
  check(it0?.input?.method === 'POST', "item[0].input.method UPPERCASED ('post' → 'POST')")
  check(it0?.output?.mimeType === 'application/json', 'item[0].output.mimeType mirrors mimeType')
  check(Array.isArray(it0?.accepts) && it0.accepts[0]?.scheme === 'onchain-proof', 'item[0].accepts carries the rail array verbatim')

  const it1 = man.items[1]
  check(it1?.input?.method === 'GET', "item[1].input.method defaults to 'GET' when method omitted")
  check(it1?.resource && !('description' in it1.resource) && !('mimeType' in it1.resource), 'omitted description/mimeType are NOT emitted as undefined keys (clean object)')
  check(!('output' in it1), 'no output block when mimeType absent')

  check(isSerializable(man), 'the whole manifest JSON.stringifies (no bigint, no cycle)')
}

// ───────────────────────── manifest: determinism ─────────────────────────
group('manifest — passing lastUpdated makes it byte-deterministic')
{
  const input = { origin: 'https://shop.example', resources: [{ url: 'https://shop.example/a', accepts: ACCEPTS, mimeType: 'text/plain' }], lastUpdated: 1_700_000_000 }
  let a, b
  try { a = JSON.stringify(buildWellKnownX402Manifest(input)); b = JSON.stringify(buildWellKnownX402Manifest(input)) } catch (e) { check(false, `deterministic build threw: ${e?.message}`) }
  check(a === b, 'same input (with lastUpdated) → byte-identical JSON twice')
  check(JSON.parse(a).lastUpdated === 1_700_000_000, 'the supplied lastUpdated is used verbatim (not overwritten by Date.now)')
}

// ───────────────────────── manifest: empty resources ─────────────────────────
group('manifest — empty resources [] is a valid empty directory, not a throw')
{
  let man
  try { man = buildWellKnownX402Manifest({ origin: 'https://shop.example', resources: [] }) } catch (e) { check(false, `empty resources threw: ${e?.message}`) }
  check(man?.x402Version === 2 && Array.isArray(man?.items) && man.items.length === 0, 'empty resources → { x402Version:2, items:[] } (well-formed empty manifest)')
  check(typeof man?.lastUpdated === 'number' && !Number.isNaN(man.lastUpdated), 'empty manifest still has a numeric (non-NaN) lastUpdated')
}

// ───────────────────────── manifest: forward-compat ─────────────────────────
group('manifest — unknown/extra fields are tolerated (forward-compat), never thrown on')
{
  let man
  try {
    man = buildWellKnownX402Manifest({
      origin: 'https://shop.example', resources: [{ url: 'https://shop.example/a', accepts: ACCEPTS, futureResourceField: 'x' }],
      lastUpdated: 42, futureTopField: { nested: true }, attribution: 'whatever',
    })
  } catch (e) { check(false, `forward-compat (extra fields) threw: ${e?.message}`) }
  check(man?.items?.length === 1 && man.items[0].resource.url === 'https://shop.example/a', 'extra unknown fields ignored, the known shape is still produced')
  check(!('futureResourceField' in (man?.items?.[0]?.resource ?? {})), 'unknown resource field is NOT leaked into the emitted resource object')
}

// ───────────────────────── manifest: hostile/malformed input ─────────────────────────
group('manifest — hostile input: a plain throw is OK, but NEVER a NaN lastUpdated / corrupt half-object')
{
  // The pure builder is allowed to throw on structurally-broken input (missing/non-array resources,
  // null input). What it must NOT do is silently emit a corrupt manifest with a NaN lastUpdated.
  const hostile = [
    ['missing resources', { origin: 'https://x.com' }],
    ['non-array resources', { origin: 'https://x.com', resources: 'nope' }],
    ['null input', null],
    ['undefined input', undefined],
    ['number input', 42],
  ]
  for (const [label, inp] of hostile) {
    let threw = false, code = '', out
    try { out = buildWellKnownX402Manifest(inp) } catch (e) { threw = true; code = e?.code }
    // 2.14.1 (F-C1): a missing/non-array `resources` is now a TYPED InvalidConfigError, not a raw
    // "Cannot read properties of … (reading 'map')" TypeError.
    check(threw && code === 'INVALID_CONFIG', `manifest(${label}) → typed InvalidConfigError (code INVALID_CONFIG), not a raw TypeError`)
  }
  // 2.14.1 (F-D4): a caller passing a non-finite lastUpdated no longer passes through to serialize as
  // JSON null — it falls back to a real now() integer.
  const nanOut = buildWellKnownX402Manifest({ origin: 'https://x.com', resources: [], lastUpdated: Number.NaN })
  check(nanOut?.x402Version === 2 && Number.isFinite(nanOut?.lastUpdated), 'manifest(lastUpdated:NaN) → a FINITE lastUpdated (coerced to now), never NaN')
  check(JSON.parse(JSON.stringify(nanOut)).lastUpdated !== null, 'the serialized manifest never carries lastUpdated:null')
}

// ───────────────────────── buildWellKnownX402 (v1 mirror) ─────────────────────────
group('buildWellKnownX402 (v1) — a flat resource-URL list')
{
  let v1
  try { v1 = buildWellKnownX402({ origin: 'https://x.com', resources: [{ url: 'https://x.com/a', accepts: ACCEPTS }, { url: 'https://x.com/b', accepts: [] }] }) } catch (e) { check(false, `buildWellKnownX402 threw: ${e?.message}`) }
  check(v1?.version === 1, 'v1 doc has version:1')
  check(Array.isArray(v1?.resources) && v1.resources.length === 2 && v1.resources[0] === 'https://x.com/a', 'v1 resources is a flat array of URLs')
  check(!('ownershipProofs' in (v1 ?? {})), 'no ownershipProofs key when none supplied')
  let v1p
  try { v1p = buildWellKnownX402({ origin: 'https://x.com', resources: [{ url: 'https://x.com/a', accepts: [] }], ownershipProofs: [{ sig: 'abc' }] }) } catch (e) { check(false, `v1 with proofs threw: ${e?.message}`) }
  check(Array.isArray(v1p?.ownershipProofs) && v1p.ownershipProofs.length === 1, 'ownershipProofs surfaced when supplied (non-empty)')
  check(isSerializable(v1) && isSerializable(v1p), 'both v1 docs serialize')
}

// ───────────────────────── buildOpenApi ─────────────────────────
group('buildOpenApi — 3.1.0 doc, info stays exactly {title,version}, x-payment-info per path')
{
  let oapi
  try {
    oapi = buildOpenApi({
      origin: 'https://x.com/', title: 'My API', version: '9.9.9',
      resources: [{ url: 'https://x.com/a/b?q=1', accepts: ACCEPTS, method: 'POST', description: 'pay me' }, { url: '/rel', accepts: [] }, { url: 'not a url', accepts: [] }],
    })
  } catch (e) { check(false, `buildOpenApi threw on valid input: ${e?.message}`) }
  check(oapi?.openapi === '3.1.0', 'openapi version is 3.1.0')
  check(JSON.stringify(Object.keys(oapi?.info ?? {})) === JSON.stringify(['title', 'version']), 'info stays EXACTLY { title, version } — the generator marker lives at the doc root')
  check(oapi?.info?.title === 'My API' && oapi?.info?.version === '9.9.9', 'title/version honored')
  check(oapi?.servers?.[0]?.url === 'https://x.com/', 'servers[0].url is the origin verbatim')
  check('/a/b' in (oapi?.paths ?? {}), 'a full URL is reduced to its pathname as the OpenAPI path key')
  check('/rel' in (oapi?.paths ?? {}), 'a relative path is used as-is')
  check('/not a url' in (oapi?.paths ?? {}), 'a non-URL resource degrades gracefully (no throw) to a leading-slash path')
  const op = oapi?.paths?.['/a/b']?.post
  check(op?.['x-payment-info']?.x402Version === 2, 'each operation carries x-payment-info.x402Version:2')
  check(op?.['x-payment-info']?.accepts === ACCEPTS, 'x-payment-info.accepts is the rail array')
  check(op?.summary === 'pay me', "the resource description becomes the operation summary")
  check(!!op?.responses?.['402'] && !!op?.responses?.['200'], 'each operation documents a 200 and a 402 response')
  check(isSerializable(oapi), 'openapi doc serializes')
}

// ───────────────────────── buildOpenApi: attribution + defaults + provenance ─────────────────────────
group('buildOpenApi — attribution default stamps GENERATOR; attribution:false strips it; defaults; provenance')
{
  const def = buildOpenApi({ origin: 'https://x.com', resources: [] })
  check(def['x-generator'] === GENERATOR, 'default → x-generator === GENERATOR')
  check(GENERATOR.includes('@piprail/sdk') && GENERATOR.includes('piprail.com'), 'GENERATOR names the SDK + site')
  check(def.info.title === 'PipRail x402 resources' && def.info.version === '1.0.0', 'sensible default title/version')

  const noAttr = buildOpenApi({ origin: 'https://x.com', resources: [], attribution: false })
  check(!('x-generator' in noAttr), 'attribution:false OMITS x-generator entirely (not "" / undefined-valued)')

  const proofs = buildOpenApi({ origin: 'https://x.com', resources: [], ownershipProofs: [{ a: 1 }] })
  check(proofs['x-agentcash-provenance']?.ownershipProofs?.length === 1, 'non-empty ownershipProofs → x-agentcash-provenance block')
  const emptyProofs = buildOpenApi({ origin: 'https://x.com', resources: [], ownershipProofs: [] })
  check(!('x-agentcash-provenance' in emptyProofs), 'empty ownershipProofs → NO provenance key')
}

// ───────────────────────── buildBazaarExtension ─────────────────────────
group('buildBazaarExtension — default no-input GET shape + JSON-schema present')
{
  let bz
  try { bz = buildBazaarExtension() } catch (e) { check(false, `buildBazaarExtension() threw: ${e?.message}`) }
  check(bz?.info?.input?.method === 'GET', 'default info.input.method === GET')
  check(bz?.info?.input?.type === 'http', "default info.input.type === 'http'")
  check(JSON.stringify(bz?.info?.input?.queryParams) === '{}', 'default queryParams is an empty object')
  check(bz?.info?.output?.type === 'json', "default info.output.type === 'json'")
  check(bz?.schema?.$schema === 'https://json-schema.org/draft/2020-12/schema', 'a draft-2020-12 JSON schema is present')
  check(Array.isArray(bz?.schema?.properties?.input?.properties?.method?.enum), 'schema constrains method to an enum')
  check(isSerializable(bz), 'bazaar extension serializes')

  // custom descriptor: method lowercased should be UPPERCASED; queryParams flow into the schema.
  let bz2
  try { bz2 = buildBazaarExtension({ method: 'post', queryParams: { q: { type: 'string' } }, output: { type: 'binary' } }) } catch (e) { check(false, `buildBazaarExtension(custom) threw: ${e?.message}`) }
  check(bz2?.info?.input?.method === 'POST', "custom method 'post' is UPPERCASED to 'POST'")
  check(JSON.stringify(bz2?.info?.output) === '{"type":"binary"}', 'custom output passed through')
  check(JSON.stringify(bz2?.schema?.properties?.input?.properties?.queryParams?.properties) === '{"q":{"type":"string"}}', 'queryParams flow into the schema.properties.input.queryParams.properties')
}

// ───────────────────────── buildX402DnsTxt ─────────────────────────
group('buildX402DnsTxt — _x402.<host> TXT record')
{
  let dns
  try { dns = buildX402DnsTxt({ host: 'x.com', discoveryUrl: 'https://x.com/.well-known/x402' }) } catch (e) { check(false, `buildX402DnsTxt threw: ${e?.message}`) }
  check(dns?.name === '_x402.x.com', 'record name is _x402.<host>')
  check(dns?.type === 'TXT', 'record type is TXT')
  check(dns?.value === 'v=x4021;url=https://x.com/.well-known/x402', 'value carries the version tag + discovery URL (no descriptor)')
  const dns2 = buildX402DnsTxt({ host: 'x.com', discoveryUrl: 'https://x.com/d', descriptor: 'foo' })
  check(dns2?.value === 'v=x4021;descriptor=foo;url=https://x.com/d', 'descriptor is inlined when supplied')
  check(isSerializable(dns) && isSerializable(dns2), 'dns records serialize')
}

// ───────────────────────── DIRECTORY_INFO / getDirectoryInfo ─────────────────────────
group('DIRECTORY_INFO / getDirectoryInfo — the honest per-source facts')
{
  check(typeof DIRECTORY_INFO === 'object' && DIRECTORY_INFO !== null, 'DIRECTORY_INFO is an object')
  // 2.14.1 (F-D2): DIRECTORY_INFO is Object.freeze'd at runtime, matching its Readonly<> type —
  // a consumer can't mutate the shared const.
  check(Object.isFrozen(DIRECTORY_INFO), 'DIRECTORY_INFO is Object.frozen (a consumer cannot mutate the shared table)')
  for (const src of ['402index', 'x402scan', 'bazaar']) {
    const info = getDirectoryInfo(src)
    check(info?.source === src, `getDirectoryInfo('${src}').source === '${src}'`)
    check(typeof info?.caveat === 'string' && info.caveat.length > 0, `'${src}' carries a non-empty honest caveat`)
  }
  // bazaar is documented as not-self-listable (PipRail verifies locally, no facilitator).
  check(getDirectoryInfo('bazaar')?.onSuccess === 'not-listable', 'bazaar.onSuccess === not-listable (no register endpoint, settle-coupled)')
  let unknown, threw = false
  try { unknown = getDirectoryInfo('does-not-exist') } catch { threw = true }
  check(!threw, 'getDirectoryInfo on an unknown source does not throw')
  check(unknown === undefined, 'getDirectoryInfo(unknown) returns undefined (not a crash)')
  check(isSerializable(DIRECTORY_INFO), 'DIRECTORY_INFO serializes')
}

// ───────────────────────── scoreResource / rankResources ─────────────────────────
group('scoreResource / rankResources — relevance ranking, graceful on sparse rows')
{
  // empty query → 0; relevant query → positive; full-match bonus.
  check(scoreResource({ resource: 'https://x.com/a', name: 'alpha' }, []) === 0, 'scoreResource with no query tokens → 0 (no throw)')
  const sAlpha = scoreResource({ resource: 'https://x.com/a', name: 'alpha pdf', category: 'pdf' }, ['pdf'])
  check(sAlpha > 0, 'a matching token yields a positive score')
  // sparse row (only resource) must not throw.
  let sparse, threwSparse = false
  try { sparse = scoreResource({}, ['foo']) } catch { threwSparse = true }
  check(!threwSparse && sparse === 0, 'scoreResource on a row with NO fields → 0 (does not throw on missing name/category/description)')

  // rankResources: empty query returns items unchanged; real query filters + scores + sorts.
  const items = [
    { resource: 'https://x.com/a', name: 'alpha' },
    { resource: 'https://x.com/b', name: 'beta gamma' },
    { resource: 'https://x.com/c', name: 'zeta' },
  ]
  let ranked0, threw0 = false
  try { ranked0 = rankResources(items, '') } catch { threw0 = true }
  check(!threw0 && ranked0?.length === 3, 'rankResources with empty query returns items unchanged (no throw)')
  let ranked, threwR = false
  try { ranked = rankResources(items, 'beta') } catch { threwR = true }
  check(!threwR && ranked?.length === 1 && ranked[0].resource === 'https://x.com/b', "rankResources('beta') keeps only the match and stamps a score")
  check(typeof ranked?.[0]?.score === 'number' && ranked[0].score > 0, 'a ranked result carries a numeric score')
  // sparse-but-present rows must not crash ranking.
  let rankedSparse, threwS = false
  try { rankedSparse = rankResources([{ resource: 'https://x.com/a' }, { resource: 'https://x.com/b', name: 'foo' }], 'foo') } catch { threwS = true }
  check(!threwS && Array.isArray(rankedSparse), 'rankResources tolerates rows missing name/category/description without throwing')
  check(isSerializable(ranked), 'ranked output serializes')
}

// ───────────────────────── searchOpenIndexes (contracted never-throw read) ─────────────────────────
group('searchOpenIndexes — network read is fault-tolerant: always an array, never a throw')
{
  // Force the network legs to fail fast with an already-aborted signal. The SDK wraps each
  // source in safeSearch, so the read must resolve to an array (possibly empty), never reject.
  let res, threw = false
  try { res = await searchOpenIndexes({ query: 'pdf', signal: AbortSignal.timeout(1) }) } catch { threw = true }
  check(!threw, 'searchOpenIndexes never rejects, even when every source aborts (the never-throw read contract)')
  check(Array.isArray(res), 'searchOpenIndexes resolves to an array')

  // No-arg call must also be safe (defaults to bazaar + 402index sources).
  let res2, threw2 = false
  try { res2 = await searchOpenIndexes({ signal: AbortSignal.timeout(1) }) } catch { threw2 = true }
  check(!threw2 && Array.isArray(res2), 'searchOpenIndexes (no query) is also fault-tolerant + returns an array')

  // An unknown source name must be ignored, not crash.
  let res3, threw3 = false
  try { res3 = await searchOpenIndexes({ query: 'x', sources: ['nonexistent-source'], signal: AbortSignal.timeout(1) }) } catch { threw3 = true }
  check(!threw3 && Array.isArray(res3), 'an unknown source name is ignored (no throw, returns array)')
}

// LIVE: this suite has no money-moving leg — discovery builders are pure + reads are network-tolerant.
if (!w) note('no .secrets wallet — irrelevant here: every check above is offline/pure (no chain, no money)')
else skip('no live leg in this suite — the discovery surface is pure functions + fault-tolerant reads')

done(w ? '08 wellknown-discovery' : '08 wellknown-discovery (offline)')

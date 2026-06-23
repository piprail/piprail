// Suite 12 — MULTI-CHAIN PLANNING + the AGENT TOOLKIT  (break-it: offline / dead-RPC)
//
// One buyer, many chains. A MultiChainPayer wraps one PipRailClient per chain (each bound to ONE
// key) and exposes ONE plan/pay that auto-routes; planAcross merges every chain's plan payable-first;
// the agent-facing renderers (summarizePlan / classifyChallenge / describeChallenge / agentGuide)
// turn the structured plan into one English line a model can act on; and the network helpers
// (normalizeNetwork / chainIdForExactNetwork / EXACT_NETWORK_SLUGS / resolveChain / CHAINS) route a
// chain value to its rail. Nothing here moves money — the whole suite is a hostile-input read-test.
//
//   OFFLINE (always — this is the whole suite; no chain writes):
//     • build a MultiChainPayer across 7 chains (EVM + Solana) with a never-funded DUMMY key; the
//       reads .clients / .spent() / .budget() / .policy() are consistent. The empty-set guards
//       (new MultiChainPayer([]) / fromWallets({wallets:{}})) THROW a typed TypeError — they refuse
//       to silently build a no-op payer.
//     • planAcross against a LIVE LOCAL 402 whose every chain client points at a DEAD rpc → returns a
//       graceful status:'unknown' plan and NEVER throws (the never-throw read contract); summarizePlan
//       stringifies any plan (incl. junk) without throwing; planAcross([], url) → null; fetchAcross([],
//       url) is the WRITE counterpart and THROWS a TypeError.
//     • pickAccept selects the matching onchain-proof rail and returns null when none match.
//     • classifyChallenge returns each of its four verdicts (PAYABLE_RAIL / UNPAYABLE_SCHEME /
//       WRONG_CHAIN / NO_RAIL) and GUARDS a nullish .accepts; describeChallenge renders a valid rail
//       and the documented generic-pointer fallback for an empty accepts[].
//     • EXACT_NETWORK_SLUGS round-trips through chainIdForExactNetwork (aliases like bnb/bsc share an id);
//       normalizeNetwork canonicalises its known slugs; resolveChain resolves every CHAINS preset and
//       THROWS on a bogus chain.
//     • agentGuide() === PIPRAIL_AGENT_GUIDE, substantial, and names paying / x402 / piprail / the tools.
//
//   KEPT-FAILING (genuine never-throw contract violations in the published artifact — see findings):
//     • classifyChallenge(null|undefined, …) THROWS a TypeError even though its own doc-comment says
//       "Never throws" (it guards a nullish .accepts but not a nullish challenge).
//     • describeChallenge crashes on an EFFECTIVELY-EMPTY accepts ({} / {accepts:null} / {accepts:undefined})
//       by reading accepts[0] with no array guard — even though its doc-comment says an empty `accepts`
//       "degrades to a generic pointer", and it is reachable from renderLandingPage / the self-describe
//       block where a FOREIGN 402's shape isn't guaranteed.
//
import {
  MultiChainPayer,
  PipRailClient,
  planAcross,
  fetchAcross,
  summarizePlan,
  classifyChallenge,
  describeChallenge,
  agentGuide,
  PIPRAIL_AGENT_GUIDE,
  pickAccept,
  normalizeNetwork,
  chainIdForExactNetwork,
  EXACT_NETWORK_SLUGS,
  resolveChain,
  CHAINS,
  createPaymentGate,
} from '@piprail/sdk'
import { check, banner, group, note, skip, done } from '../lib/report.mjs'
import { loadWallet, RPC, DUMMY_KEY } from '../lib/env.mjs'
import { serveGate } from '../lib/http-gate.mjs'

banner('12 · MULTI-CHAIN PLANNING + AGENT TOOLKIT')
const w = loadWallet()
const MERCHANT = w?.merchant ?? '0x28Dc25bf88BF06fc0a3Af1747D1aA4a21f313ed0'
const DEAD_RPC = 'http://127.0.0.1:1' // nothing listens → every chain READ fails (but must never throw)

// Helper: did `fn` throw? Returns 'ok' or `THREW:<ctorName>`. Awaits a returned promise so an async
// rejection is caught the same way a synchronous throw is.
const threw = async (fn) => {
  try {
    const r = fn()
    if (r && typeof r.then === 'function') { await r; return 'ok' }
    return 'ok'
  } catch (e) {
    return `THREW:${e?.constructor?.name ?? 'unknown'}`
  }
}

// A real, structurally-valid multi-rail v2 challenge (a literal — no network needed). Two rails:
// an onchain-proof rail on Base + an exact rail on Polygon — so we can exercise every verdict.
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const POLY_USDC = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'
const challenge = {
  x402Version: 1,
  accepts: [
    { scheme: 'onchain-proof', network: 'eip155:8453', asset: BASE_USDC, amount: '10000', payTo: MERCHANT, maxTimeoutSeconds: 600, extra: { amountFormatted: '0.01', symbol: 'USDC' } },
    { scheme: 'exact', network: 'eip155:137', asset: POLY_USDC, amount: '10000', payTo: MERCHANT, maxTimeoutSeconds: 600, extra: { amountFormatted: '0.01', symbol: 'USDC' } },
  ],
  resource: { url: 'http://127.0.0.1:1/m' },
}

// ───────────────────────── OFFLINE — MultiChainPayer construction + reads ─────────────────────────
group('offline — MultiChainPayer: build across 7 chains (never-funded DUMMY key) + empty-set guards')
{
  const CHAINS_LIST = ['base', 'polygon', 'arbitrum', 'optimism', 'bnb', 'avalanche', 'solana']
  let payer = null
  try {
    payer = MultiChainPayer.fromWallets({ wallets: Object.fromEntries(CHAINS_LIST.map((c) => [c, { key: DUMMY_KEY }])) })
  } catch (e) {
    check(false, `MultiChainPayer.fromWallets threw on a 7-chain DUMMY map: ${e?.message}`)
  }
  check(!!payer, 'MultiChainPayer.fromWallets built a payer across 7 chains (EVM + Solana) with a never-funded key')
  check(payer?.clients?.length === CHAINS_LIST.length, `it owns one PipRailClient per listed chain (got ${payer?.clients?.length})`)
  check(payer?.clients?.every((c) => c instanceof PipRailClient) === true, 'every owned client is a real PipRailClient')

  // spent()/budget()/policy() are read-only and consistent on a fresh payer (no payments yet).
  let spent, budget
  const spentThrew = await threw(() => { spent = payer.spent() })
  const budgetThrew = await threw(() => { budget = payer.budget() })
  check(spentThrew === 'ok' && budgetThrew === 'ok', 'spent()/budget() are read-only and never throw on a fresh payer')
  check(spent?.count === 0, 'a fresh shared-ledger payer reports 0 payments across all chains')
  check(Array.isArray(spent?.byDenom) && Array.isArray(spent?.records) && Array.isArray(spent?.byAsset), 'spent() has the SpendSummary shape (byAsset + byDenom + records arrays)')
  check(spent?.records.length === 0 && spent?.byAsset.length === 0, 'a never-paid ledger has no asset rows and no records')
  check(!!budget?.session && Array.isArray(budget?.byAsset) && !!budget?.counts, 'budget() has the SessionBudget shape (session + byAsset + counts)')
  check(payer?.policy() === undefined, 'policy() is undefined when none was configured')

  // The empty-set guards must throw a typed TypeError — NOT silently build a no-op payer that
  // would never find a rail and confuse every downstream read.
  check((await threw(() => new MultiChainPayer([]))) === 'THREW:TypeError', 'new MultiChainPayer([]) throws a TypeError (refuses an empty client set)')
  check((await threw(() => MultiChainPayer.fromWallets({ wallets: {} }))) === 'THREW:TypeError', 'MultiChainPayer.fromWallets({wallets:{}}) throws a TypeError (no funded chains)')
  check((await threw(() => MultiChainPayer.fromWallets({}))) === 'THREW:TypeError', 'MultiChainPayer.fromWallets({}) throws a TypeError (no wallets at all)')
}

// ───────────────────────── OFFLINE — planAcross / fetchAcross (dead-RPC, never-throw) ─────────────────────────
group('offline — planAcross against a LIVE local 402 with a DEAD rpc: graceful plan, never throws')
{
  // The gate only needs an rpcUrl to construct + challenge (challenge() does NOT read the chain),
  // so a dead rpc serves a perfectly valid Base-only onchain-proof 402.
  const gate = createPaymentGate({ chain: 'base', token: 'USDC', amount: '0.01', payTo: MERCHANT, rpcUrl: DEAD_RPC })
  const srv = serveGate(gate, { port: 4921, path: '/m' })
  await srv.listen()
  try {
    // Three single-chain clients, all on dead RPCs: base sees the 402; polygon/arbitrum see a
    // Base-only 402 (wrong chain → contribute no rail). NO read can succeed, so the merge must be
    // 'unknown', never a throw.
    const clients = [
      new PipRailClient({ chain: 'base', wallet: { key: DUMMY_KEY }, rpcUrl: DEAD_RPC }),
      new PipRailClient({ chain: 'polygon', wallet: { key: DUMMY_KEY }, rpcUrl: DEAD_RPC }),
      new PipRailClient({ chain: 'arbitrum', wallet: { key: DUMMY_KEY }, rpcUrl: DEAD_RPC }),
    ]

    let plan
    const planThrew = await threw(async () => { plan = await planAcross(clients, srv.url) })
    check(planThrew === 'ok', `planAcross does not throw on a dead RPC (never-throw read contract) — got ${planThrew}`)
    if (planThrew === 'ok') {
      check(plan != null, 'planAcross returned a merged plan (not null) for a gated URL')
      check(plan?.payable === false, 'an unfunded/unreadable plan is NOT payable')
      check(plan?.status === 'unknown' || plan?.status === 'blocked', `status is a real plan state (got ${plan?.status})`)
      check(plan?.network === 'eip155:8453', 'merged plan.network === the offered Base rail (eip155:8453)')
      check(Array.isArray(plan?.options) && plan.options.length >= 1, 'plan.options carries at least the base rail')
      // Only the base client could see a payable-on-its-chain rail; off-chain clients add no option.
      check(plan?.options.every((o) => o.accept?.network === 'eip155:8453') === true, 'every merged option sits on the offered Base rail (off-chain clients contribute none)')
      check(plan?.best === null, 'no rail is settleable on a dead RPC → best is null')
      check(typeof plan?.fundingHint === 'string' && plan.fundingHint.length > 0, 'a non-payable plan carries a human fundingHint string')

      // summarizePlan must stringify ANY plan without throwing.
      let summary
      const sumThrew = await threw(() => { summary = summarizePlan(plan) })
      check(sumThrew === 'ok' && typeof summary === 'string' && summary.length > 0, 'summarizePlan(plan) → a non-empty English line (never throws)')
      check(/NOT payable/i.test(summary), 'summarizePlan reports the un-settleable plan as NOT payable')
      note(`summary: ${summary.slice(0, 110)}`)
    }

    // The empty / null edges of the across-helpers.
    let emptyPlan
    const emptyThrew = await threw(async () => { emptyPlan = await planAcross([], srv.url) })
    check(emptyThrew === 'ok' && emptyPlan === null, 'planAcross([], url) → null (graceful, never throws on an empty client list)')
    check(summarizePlan(null) === 'No payment required — the URL is not payment-gated.', 'summarizePlan(null) → the "no payment required" line')
    // summarizePlan must also tolerate a STRUCTURALLY-junk plan (a foreign/partial object) without throwing.
    check((await threw(() => summarizePlan({}))) === 'ok', 'summarizePlan({}) does not throw on a junk plan (read-only renderer)')
    check((await threw(() => summarizePlan(undefined))) === 'ok', 'summarizePlan(undefined) does not throw')
    // fetchAcross([]) is the WRITE counterpart — it must refuse loudly with a TypeError, never pay nothing.
    check((await threw(() => fetchAcross([], srv.url))) === 'THREW:TypeError', 'fetchAcross([], url) throws a TypeError (refuses to pay with no clients)')
  } finally {
    srv.close()
  }
}

// ───────────────────────── OFFLINE — pickAccept ─────────────────────────
group('offline — pickAccept: matches the onchain-proof rail, returns null when none match (no throw)')
{
  let picked
  const pickThrew = await threw(() => { picked = pickAccept(challenge, (n) => n === 'eip155:8453') })
  check(pickThrew === 'ok', `pickAccept does not throw on a valid challenge — got ${pickThrew}`)
  if (pickThrew === 'ok') {
    check(picked != null && picked.scheme === 'onchain-proof' && picked.network === 'eip155:8453', 'pickAccept returns the onchain-proof rail whose network the predicate accepts')
    // No network matches → null, no throw.
    check(pickAccept(challenge, () => false) === null, 'pickAccept → null when the predicate matches no rail')
    // The predicate matches ONLY the exact rail; pickAccept selects onchain-proof only → null.
    check(pickAccept(challenge, (n) => n === 'eip155:137') === null, 'pickAccept ignores a matching EXACT rail (it selects onchain-proof only) → null')
    // An empty-accepts (but present) challenge → null, never a throw.
    check(pickAccept({ accepts: [] }, () => true) === null, 'pickAccept({accepts:[]}, …) → null (never throws)')
  }
}

// ───────────────────────── OFFLINE — classifyChallenge verdicts ─────────────────────────
group('offline — classifyChallenge: all four verdicts + it guards a nullish .accepts')
{
  const onBase = { network: 'eip155:8453', schemes: ['onchain-proof'] }
  check(classifyChallenge(challenge, onBase).verdict === 'PAYABLE_RAIL', 'on-chain rail + enabled scheme → PAYABLE_RAIL')
  check(classifyChallenge(challenge, { network: 'eip155:8453', schemes: ['exact'] }).verdict === 'UNPAYABLE_SCHEME', 'on-chain rail but the scheme is not enabled → UNPAYABLE_SCHEME')
  check(classifyChallenge(challenge, { network: 'eip155:999999', schemes: ['onchain-proof'] }).verdict === 'WRONG_CHAIN', 'rails exist but none on the client chain → WRONG_CHAIN')
  check(classifyChallenge({ accepts: [] }, onBase).verdict === 'NO_RAIL', 'no rails at all → NO_RAIL')
  // The triage surfaces the distinct offered schemes/networks for an agent to branch on.
  const tri = classifyChallenge(challenge, onBase)
  check(tri.offeredSchemes.includes('onchain-proof') && tri.offeredSchemes.includes('exact'), 'classifyChallenge.offeredSchemes lists every distinct scheme')
  check(tri.offeredNetworks.includes('eip155:8453') && tri.offeredNetworks.includes('eip155:137'), 'classifyChallenge.offeredNetworks lists every distinct network')
  check(tri.onClientChain === true && tri.payableScheme === true, 'classifyChallenge surfaces the onClientChain / payableScheme booleans')
  // Doc says "Never throws": an accepts-less / odd-but-non-null challenge must NOT throw.
  check((await threw(() => classifyChallenge({}, onBase))) === 'ok', 'classifyChallenge({}, …) does not throw (guards a missing accepts)')
  check((await threw(() => classifyChallenge({ accepts: null }, onBase))) === 'ok', 'classifyChallenge({accepts:null}, …) does not throw (guards a nullish accepts)')
  check(classifyChallenge({ accepts: null }, onBase).verdict === 'NO_RAIL', 'a nullish-accepts challenge classifies as NO_RAIL (not a crash)')
}

// ───────────────────────── OFFLINE — describeChallenge ─────────────────────────
group('offline — describeChallenge: renders a valid rail + the documented empty-accepts fallback')
{
  let desc
  const descThrew = await threw(() => { desc = describeChallenge(challenge) })
  check(descThrew === 'ok', `describeChallenge does not throw on a valid challenge — got ${descThrew}`)
  if (descThrew === 'ok') {
    check(typeof desc === 'string' && /pay 0\.01 USDC/.test(desc) && desc.includes(MERCHANT), 'describeChallenge renders the first rail amount/token/recipient')
    check(/@piprail\/sdk/.test(desc) && /client\.fetch/.test(desc), 'describeChallenge tells the agent HOW to pay (npm i @piprail/sdk → client.fetch)')
  }
  // The documented degraded path: an empty `accepts` array → a generic pointer, not a throw.
  let degraded
  const degradedThrew = await threw(() => { degraded = describeChallenge({ accepts: [] }) })
  check(degradedThrew === 'ok' && typeof degraded === 'string' && /@piprail\/sdk/.test(degraded), 'describeChallenge({accepts:[]}) → the generic-pointer fallback (no throw)')
}

// ───────────────────────── OFFLINE — network helpers ─────────────────────────
group('offline — EXACT_NETWORK_SLUGS ⇄ chainIdForExactNetwork + normalizeNetwork + resolveChain/CHAINS')
{
  // Every exact slug round-trips to its chain id, and an unknown slug → null (never a throw).
  // Slugs are MANY-to-one: aliases (e.g. bnb / bsc → 56) deliberately collide, which is correct;
  // the contract is that each slug round-trips to ITS id, not that ids are unique.
  let allRoundTrip = true
  for (const [slug, id] of Object.entries(EXACT_NETWORK_SLUGS)) {
    if (chainIdForExactNetwork(slug) !== id) { allRoundTrip = false; note(`exact-slug mismatch: ${slug} → ${chainIdForExactNetwork(slug)} (expected ${id})`) }
  }
  check(Object.keys(EXACT_NETWORK_SLUGS).length > 0, `EXACT_NETWORK_SLUGS is non-empty (${Object.keys(EXACT_NETWORK_SLUGS).length} slugs)`)
  check(allRoundTrip, 'every EXACT_NETWORK_SLUGS entry round-trips through chainIdForExactNetwork')
  // The bnb/bsc alias pair must agree on the same chain id (56) — an alias is intentional, not a clash.
  check(EXACT_NETWORK_SLUGS.bnb === EXACT_NETWORK_SLUGS.bsc && chainIdForExactNetwork('bsc') === chainIdForExactNetwork('bnb'), 'the bnb/bsc aliases resolve to the SAME chain id (intentional many-to-one)')
  check(chainIdForExactNetwork('definitely-not-a-chain') === null, 'chainIdForExactNetwork(<bogus>) → null (never throws)')
  check(chainIdForExactNetwork('eip155:8453') === null, 'chainIdForExactNetwork takes the SLUG, not the CAIP-2 form → null for "eip155:8453"')
  check((await threw(() => chainIdForExactNetwork(null))) === 'ok' && chainIdForExactNetwork(null) === null, 'chainIdForExactNetwork(null) → null (never throws on a nullish slug)')

  // normalizeNetwork canonicalises its KNOWN slugs to CAIP-2 and passes a CAIP-2 id through unchanged.
  check(normalizeNetwork('base') === 'eip155:8453', 'normalizeNetwork("base") → eip155:8453')
  check(normalizeNetwork('BASE') === 'eip155:8453', 'normalizeNetwork is case-insensitive ("BASE" → eip155:8453)')
  check(normalizeNetwork('eip155:8453') === 'eip155:8453', 'normalizeNetwork passes a CAIP-2 id through unchanged')
  check(normalizeNetwork('polygon') === 'eip155:137', 'normalizeNetwork("polygon") → eip155:137')
  check(normalizeNetwork('solana') === 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', 'normalizeNetwork("solana") → the bound Solana CAIP-2')
  check(normalizeNetwork('ton:-239') === 'tvm:-239', 'normalizeNetwork canonicalises the legacy TON id (ton:-239 → tvm:-239)')
  check(normalizeNetwork('utterly-unknown-slug') === 'utterly-unknown-slug', 'an UNKNOWN slug returns unchanged (no colon → "unresolved, do not hide it")')
  check((await threw(() => normalizeNetwork('whatever'))) === 'ok', 'normalizeNetwork never throws on a junk (string) slug')

  // resolveChain resolves EVERY CHAINS preset to a { chain, chainId, rpcUrl, … } record …
  let allPresetsResolve = true
  for (const name of Object.keys(CHAINS)) {
    try {
      const r = resolveChain(name)
      if (!r || typeof r.chainId !== 'number' || !r.rpcUrl || !r.chain) { allPresetsResolve = false; note(`resolveChain("${name}") returned an odd record`) }
    } catch (e) {
      allPresetsResolve = false
      note(`resolveChain("${name}") THREW: ${e?.message?.slice(0, 60)}`)
    }
  }
  check(Object.keys(CHAINS).length > 0, `CHAINS exposes the built-in EVM presets (${Object.keys(CHAINS).length})`)
  check(allPresetsResolve, 'resolveChain resolves every CHAINS preset to a usable { chain, chainId, rpcUrl } record')
  check(resolveChain('base').chainId === CHAINS.base.chain.id, 'resolveChain("base").chainId === CHAINS.base.chain.id (consistent)')
  check(typeof resolveChain('base').rpcUrl === 'string' && resolveChain('base').rpcUrl.length > 0, 'resolveChain("base").rpcUrl is a non-empty endpoint')

  // … and THROWS on a bogus chain (a config mistake, NOT a never-throw read).
  let bogusErr = null
  try {
    resolveChain('not-a-real-chain-xyz')
    check(false, 'resolveChain did NOT throw on a bogus chain')
  } catch (e) {
    bogusErr = e
  }
  check(bogusErr instanceof Error, 'resolveChain THROWS on a bogus chain name (loud config failure)')
  check(/unknown chain/i.test(bogusErr?.message ?? ''), 'the bogus-chain error names the failure ("unknown chain …")')
  // resolveChain is the EVM-only preset resolver — a non-EVM family name (solana) is NOT a preset here.
  check((await threw(() => resolveChain('solana'))) === 'THREW:Error', 'resolveChain("solana") throws (it is the EVM-preset resolver; solana is not an EVM preset)')
}

// ───────────────────────── OFFLINE — agentGuide ─────────────────────────
group('offline — agentGuide() / PIPRAIL_AGENT_GUIDE')
{
  let guide
  const guideThrew = await threw(() => { guide = agentGuide() })
  check(guideThrew === 'ok', `agentGuide() does not throw — got ${guideThrew}`)
  if (guideThrew === 'ok') {
    check(typeof guide === 'string' && guide.length > 200, 'agentGuide() returns a substantial guide string')
    check(guide === PIPRAIL_AGENT_GUIDE, 'agentGuide() === the PIPRAIL_AGENT_GUIDE constant')
    check(/x402/i.test(guide), 'the guide mentions x402')
    check(/\bpay/i.test(guide), 'the guide mentions paying')
    check(/piprail/i.test(guide), 'the guide mentions PipRail')
    // It must name the tools an agent will literally invoke (a wrong/missing name actively misleads).
    check(/piprail_pay_request/.test(guide) && /piprail_plan_payment/.test(guide) && /piprail_quote_payment/.test(guide), 'the guide names the quote → plan → pay tool trio accurately')
  }
}

// ───────────────────────── OFFLINE — the never-throw contract HOLDS (F-A1/F-A2, fixed in 2.14.1) ─────────────
// classifyChallenge's doc-comment says "Never throws"; describeChallenge's says an empty `accepts`
// "degrades to a generic pointer". Both are reachable from renderLandingPage / the self-describe block
// where a FOREIGN 402's shape isn't guaranteed. 2.14.1 guards `accepts` so a nullish / shapeless
// challenge degrades to a verdict / pointer instead of throwing a raw TypeError.
group('offline — classifyChallenge / describeChallenge NEVER throw on a nullish/shapeless challenge (F-A1/F-A2)')
{
  const opts = { network: 'eip155:8453', schemes: ['onchain-proof'] }
  for (const bad of [null, undefined, {}, { accepts: null }, { accepts: undefined }, 'nope', 42]) {
    const lbl = JSON.stringify(bad) ?? String(bad)
    const r = await threw(() => classifyChallenge(bad, opts))
    check(r === 'ok', `classifyChallenge(${lbl}) does not throw → degrades to a verdict`)
    // and the verdict is the sane NO_RAIL bucket, not garbage
    let v; try { v = classifyChallenge(bad, opts) } catch { v = null }
    check(v?.verdict === 'NO_RAIL' && v.onClientChain === false, `classifyChallenge(${lbl}) → verdict NO_RAIL`)
  }
  for (const bad of [null, undefined, {}, { accepts: null }, { accepts: undefined }, { accepts: [] }]) {
    const lbl = JSON.stringify(bad) ?? String(bad)
    check((await threw(() => describeChallenge(bad))) === 'ok', `describeChallenge(${lbl}) does not throw → generic pointer`)
    let s = ''; try { s = describeChallenge(bad) } catch { s = '' }
    check(typeof s === 'string' && /x402 payment endpoint/.test(s), `describeChallenge(${lbl}) → a usable pointer string`)
  }
  // a nullish opts also degrades (the second arg is no longer assumed present)
  check((await threw(() => classifyChallenge({ accepts: [] }, undefined))) === 'ok', 'classifyChallenge(challenge, undefined opts) does not throw')
}

// ───────────────────────── LIVE (Base mainnet, READ-ONLY — money-free RPC read) ─────────────────────────
if (!(w && process.env.PIPRAIL_LIVE === '1')) {
  skip('no .secrets wallet + PIPRAIL_LIVE=1 → skipping the live (read-only) planAcross against a real RPC')
} else {
  group('live — planAcross against a real Base RPC: a REAL blocked plan with INSUFFICIENT_* blockers')
  {
    const gate = createPaymentGate({ chain: 'base', token: 'USDC', amount: '0.01', payTo: MERCHANT, rpcUrl: RPC })
    const srv = serveGate(gate, { port: 4922, path: '/m' })
    await srv.listen()
    try {
      // A never-funded DUMMY key on the REAL Base RPC — a real read, but no money moves.
      const clients = [new PipRailClient({ chain: 'base', wallet: { key: DUMMY_KEY }, rpcUrl: RPC })]
      let plan
      const liveThrew = await threw(async () => { plan = await planAcross(clients, srv.url) })
      check(liveThrew === 'ok', `live planAcross does not throw on a real RPC — got ${liveThrew}`)
      if (liveThrew === 'ok') {
        check(plan?.status === 'blocked', 'a real read of a never-funded wallet → status:"blocked" (definitively un-settleable)')
        check(plan?.payable === false && plan?.best === null, 'the plan is not payable and names no best rail')
        const blockers = plan?.options?.[0]?.blockers ?? []
        check(blockers.includes('INSUFFICIENT_TOKEN'), 'the base rail surfaces INSUFFICIENT_TOKEN (the never-funded wallet holds no USDC)')
        note(`live blockers: ${blockers.join(', ')} · hint: ${(plan?.fundingHint ?? '').slice(0, 90)}`)
        const summary = summarizePlan(plan)
        check(/USDC/.test(summary), 'summarizePlan names the USDC shortfall')
      }
    } finally {
      srv.close()
    }
  }
}

done(w && process.env.PIPRAIL_LIVE === '1' ? '12 multichain-agent' : '12 multichain-agent (offline)')

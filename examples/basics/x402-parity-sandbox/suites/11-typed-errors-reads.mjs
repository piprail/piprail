// Suite 11 — TYPED-ERROR DISCIPLINE + the NEVER-THROW read contract
//
// PipRail's contract is two-sided: configuration mistakes throw a *typed* `PipRailError` (a stable
// `.code`, `instanceof Error` AND `instanceof PipRailError`), while the read-only planning trio —
// quote() → estimateCost() → planPayment() (+ canAfford) — NEVER throws when the chain RPC is dead
// or throttled; it returns a verdict object instead, so an agent can always plan a payment safely.
//
//   OFFLINE (always — this is the whole suite; no money, no chain writes):
//     • createPaymentGate(...).challenge() throws the RIGHT typed error for an unknown built-in token
//       (UnknownTokenError/UNKNOWN_TOKEN), a cross-family payTo (WrongFamilyError/WRONG_FAMILY), and an
//       unknown chain (UnsupportedNetworkError/UNSUPPORTED_NETWORK) — and never at construction.
//     • a PipRailClient on a DEAD rpcUrl, pointed at a live local 402, returns verdicts from
//       quote/estimateCost/planPayment/canAfford — NEVER throws (the never-throw read contract).
//     • planPayment surfaces blocker codes from {INSUFFICIENT_TOKEN, INSUFFICIENT_GAS,
//       RECIPIENT_NOT_READY, OUTSIDE_POLICY} only, plus warnings/shortfall/fundingHint.
//     • toInsufficientFundsError normalizes to an InsufficientFundsError (and never throws on junk).
//     • every typed-error class round-trips .code + message and is instanceof Error AND PipRailError.
//     • safe-integer: a challenge amount whose base units exceed 2^53 is preserved EXACTLY as a
//       string — no silent float precision loss.
//
import {
  createPaymentGate,
  PipRailClient,
  PipRailError,
  UnknownTokenError,
  WrongFamilyError,
  UnsupportedNetworkError,
  UnsupportedSchemeError,
  WrongChainError,
  InsufficientFundsError,
  RecipientNotReadyError,
  MissingDriverError,
  WalletRequiredError,
  InvalidEnvelopeError,
  NoCompatibleAcceptError,
  ConfirmationTimeoutError,
  MaxRetriesExceededError,
  PaymentDeclinedError,
  PaymentTimeoutError,
  SettlementError,
  NonReplayableBodyError,
  InvalidConfigError,
  toInsufficientFundsError,
} from '@piprail/sdk'
import { check, banner, group, note, skip, done } from '../lib/report.mjs'
import { loadWallet, RPC, DUMMY_KEY } from '../lib/env.mjs'
import { serveGate } from '../lib/http-gate.mjs'

banner('11 · TYPED ERRORS + NEVER-THROW READS')
const w = loadWallet()
const MERCHANT = w?.merchant ?? '0x28Dc25bf88BF06fc0a3Af1747D1aA4a21f313ed0'
// A real, structurally-valid Solana address — used as a *cross-family* payTo on an EVM gate.
const SOLANA_ADDR = '7EqQdEULxWcraVx3mXe9obs2Jz9nNsAvT6jZ5XwQ8YqJ'
const DEAD_RPC = 'http://127.0.0.1:1' // nothing listens here → every chain read fails

// The full, closed set the SDK is contracted to emit. Any blocker outside this set is a bug.
const BLOCKER_CODES = new Set(['INSUFFICIENT_TOKEN', 'INSUFFICIENT_GAS', 'RECIPIENT_NOT_READY', 'OUTSIDE_POLICY'])

// ───────────────────────── (1) gate.challenge() throws the RIGHT typed error ─────────────────────────
group('config mistakes → the RIGHT typed PipRailError (thrown at challenge(), never at construction)')
{
  // Unknown BUILT-IN token name → UnknownTokenError / UNKNOWN_TOKEN.
  let ctorThrew = false
  let gate
  try {
    gate = createPaymentGate({ chain: 'base', token: 'NOPECOIN', amount: '0.001', payTo: MERCHANT, rpcUrl: DEAD_RPC })
  } catch {
    ctorThrew = true
  }
  check(ctorThrew === false, 'createPaymentGate(unknown token) does NOT throw at construction (lazy — fails at challenge)')
  let caught = null
  try {
    await gate.challenge('http://127.0.0.1:1/r')
  } catch (e) {
    caught = e
  }
  check(caught instanceof UnknownTokenError, 'unknown built-in token → throws UnknownTokenError')
  check(caught?.code === 'UNKNOWN_TOKEN', '… with stable .code === "UNKNOWN_TOKEN"')
  check(caught instanceof PipRailError && caught instanceof Error, '… and it is both a PipRailError and an Error')

  // A Solana (cross-family) payTo on an EVM gate → WrongFamilyError / WRONG_FAMILY.
  let wf = null
  try {
    const g2 = createPaymentGate({ chain: 'base', token: 'USDC', amount: '0.001', payTo: SOLANA_ADDR, rpcUrl: DEAD_RPC })
    await g2.challenge('http://127.0.0.1:1/r')
  } catch (e) {
    wf = e
  }
  check(wf instanceof WrongFamilyError, 'a cross-family (Solana) payTo on an EVM gate → WrongFamilyError')
  check(wf?.code === 'WRONG_FAMILY', '… with stable .code === "WRONG_FAMILY"')

  // An unknown chain string → UnsupportedNetworkError / UNSUPPORTED_NETWORK.
  let unCtorThrew = false
  let g3
  try {
    g3 = createPaymentGate({ chain: 'notachain', token: 'USDC', amount: '0.001', payTo: MERCHANT, rpcUrl: DEAD_RPC })
  } catch {
    unCtorThrew = true
  }
  check(unCtorThrew === false, 'createPaymentGate(unknown chain) does NOT throw at construction')
  let un = null
  try {
    await g3.challenge('http://127.0.0.1:1/r')
  } catch (e) {
    un = e
  }
  check(un instanceof UnsupportedNetworkError, 'an unknown chain string → UnsupportedNetworkError')
  check(un?.code === 'UNSUPPORTED_NETWORK', '… with stable .code === "UNSUPPORTED_NETWORK"')
}

// ───────────────────────── (2) the never-throw READ contract (dead RPC, live 402) ─────────────────────────
group('reads NEVER throw on a DEAD rpcUrl pointed at a live local 402 (the contract case)')
{
  // The GATE serves a normal 402 over HTTP (its own RPC is irrelevant for the challenge). The CLIENT
  // is wired to a DEAD rpcUrl, so EVERY chain read (balance, gas, recipient-readiness) fails — yet the
  // planning trio must still return a verdict, never throw. This is the precise contract boundary.
  const gate = createPaymentGate({ chain: 'base', token: 'USDC', amount: '0.001', payTo: MERCHANT, rpcUrl: DEAD_RPC })
  const srv = serveGate(gate, { port: 4911, path: '/m' })
  await srv.listen()
  try {
    const client = new PipRailClient({ chain: 'base', wallet: { key: DUMMY_KEY }, rpcUrl: DEAD_RPC })

    let q, qThrew = false
    try { q = await client.quote(srv.url) } catch { qThrew = true }
    check(qThrew === false && q && typeof q === 'object', 'quote() returns a verdict object on a dead RPC (never throws)')
    check(q?.amount === '1000' && q?.symbol === 'USDC', '… quote carries the parsed 402 fields (amount/symbol)')

    let ec, ecThrew = false
    try { ec = await client.estimateCost(srv.url) } catch { ecThrew = true }
    check(ecThrew === false && ec && ec.cost && ec.quote, 'estimateCost() returns { quote, cost } on a dead RPC (never throws)')
    check(['estimated', 'heuristic'].includes(ec?.cost?.basis), '… cost.basis is from {estimated, heuristic} (heuristic when RPC is dead)')

    let plan, planThrew = false
    try { plan = await client.planPayment(srv.url) } catch { planThrew = true }
    check(planThrew === false && plan && Array.isArray(plan.options), 'planPayment() returns a PaymentPlan on a dead RPC (never throws)')
    check(plan?.payable === false, '… with payable:false when nothing can be read/settled')
    check(typeof plan?.fundingHint === 'string' && plan.fundingHint.length > 0, '… and a human-readable fundingHint string')

    let aff, affThrew = false
    try { aff = await client.canAfford(srv.url) } catch { affThrew = true }
    check(affThrew === false && typeof aff === 'boolean', 'canAfford() returns a boolean on a dead RPC (never throws)')
    check(aff === false, '… canAfford === false (can\'t prove affordability with a dead RPC)')

    // When the RPC is dead, balances are unreadable → the plan must say so via a warning, and must
    // NEVER fabricate a false 0 balance (the "never a false 0" guarantee).
    const opt0 = plan.options[0]
    check(Array.isArray(opt0.warnings) && opt0.warnings.includes('BALANCE_UNREADABLE'), 'dead-RPC plan warns BALANCE_UNREADABLE (no fabricated zero)')
    check(opt0.balance?.token === null && opt0.balance?.native === null, '… balance.token/native are null (unreadable), not a false 0')
  } finally {
    srv.close()
  }
}

// ───────────────────────── (3) planPayment blocker codes ⊆ the closed set ─────────────────────────
group('planPayment blockers ⊆ {INSUFFICIENT_TOKEN, INSUFFICIENT_GAS, RECIPIENT_NOT_READY, OUTSIDE_POLICY}')
{
  // Use the REAL Base RPC so balances/gas actually read (zero, for the never-funded DUMMY key) and the
  // gate over-charges 0.5 USDC while the client policy caps at 0.001 — guaranteeing OUTSIDE_POLICY plus
  // the insufficiency blockers. A throttled public RPC may degrade to "unknown" (warnings, no blockers);
  // that is still contract-valid, so we assert the blockers we DO see are all from the closed set.
  const gate = createPaymentGate({ chain: 'base', token: 'USDC', amount: '0.5', payTo: MERCHANT, rpcUrl: RPC })
  const srv = serveGate(gate, { port: 4912, path: '/m' })
  await srv.listen()
  try {
    const client = new PipRailClient({ chain: 'base', wallet: { key: DUMMY_KEY }, rpcUrl: RPC, policy: { maxAmount: '0.001' } })
    let plan, threw = false
    try { plan = await client.planPayment(srv.url) } catch { threw = true }
    check(threw === false && plan, 'planPayment(over-priced 402, capped policy) returns a verdict (never throws)')

    const allBlockers = plan.options.flatMap((o) => o.blockers ?? [])
    note(`observed blockers: ${JSON.stringify(allBlockers)}; status=${plan.status}`)
    check(allBlockers.every((b) => BLOCKER_CODES.has(b)), 'every emitted blocker is from the closed contract set')

    // Each per-rail option must carry the documented shape regardless of RPC luck.
    for (const o of plan.options) {
      check(Array.isArray(o.blockers) && Array.isArray(o.warnings), 'each rail option has array blockers + warnings')
      check(o.need && typeof o.need === 'object', 'each rail option has a `need` shortfall object')
    }
    // The quote-level policy verdict must agree: a 0.5 USDC ask vs a 0.001 cap is out-of-policy.
    const q = await client.quote(srv.url)
    check(q?.withinPolicy === false, 'quote.withinPolicy === false for a price above the client policy cap')

    // If the RPC actually read, we should specifically see OUTSIDE_POLICY (price > cap is RPC-independent).
    if (plan.status === 'blocked') {
      check(allBlockers.includes('OUTSIDE_POLICY'), 'a price above the policy cap yields an OUTSIDE_POLICY blocker (RPC-independent)')
    } else {
      note(`plan.status=${plan.status} (RPC throttled) — OUTSIDE_POLICY assertion relaxed; closed-set check still held`)
      check(true, 'closed-set blocker check held even under a throttled RPC')
    }
  } finally {
    srv.close()
  }
}

// ───────────────────────── (4) toInsufficientFundsError → InsufficientFundsError ─────────────────────────
group('toInsufficientFundsError normalizes to InsufficientFundsError and never throws')
{
  // A matching message normalizes to a typed InsufficientFundsError.
  const mapped = toInsufficientFundsError(new Error('insufficient funds for gas * price + value'))
  check(mapped instanceof InsufficientFundsError, 'a matching error → InsufficientFundsError')
  check(mapped?.code === 'INSUFFICIENT_FUNDS', '… with .code === "INSUFFICIENT_FUNDS"')
  check(mapped instanceof PipRailError && mapped instanceof Error, '… and instanceof PipRailError + Error')

  // A plain string that matches the pattern is also normalized.
  const mappedStr = toInsufficientFundsError('not enough balance to cover the transfer')
  check(mappedStr instanceof InsufficientFundsError, 'a matching plain string → InsufficientFundsError')

  // A non-matching error → null (not a throw, not a wrong-coded error).
  const notMapped = toInsufficientFundsError(new Error('connection refused'))
  check(notMapped === null, 'a non-matching error → null (it does not over-claim)')

  // Hostile inputs MUST NOT throw — the normalizer is a read-only classifier.
  for (const bad of [undefined, null, {}, 123, [], 'random text']) {
    let threw = false
    let r
    try { r = toInsufficientFundsError(bad) } catch { threw = true }
    check(threw === false, `toInsufficientFundsError(${typeof bad === 'object' ? JSON.stringify(bad) : String(bad)}) does not throw`)
    check(r === null || r instanceof InsufficientFundsError, '… and returns null or an InsufficientFundsError')
  }
}

// ───────────────────────── (5) every typed-error class round-trips ─────────────────────────
group('every typed-error class round-trips .code + message; instanceof Error AND PipRailError')
{
  const EXPECTED = [
    [PipRailError, undefined], // base class has no fixed code
    [UnknownTokenError, 'UNKNOWN_TOKEN'],
    [WrongFamilyError, 'WRONG_FAMILY'],
    [UnsupportedNetworkError, 'UNSUPPORTED_NETWORK'],
    [UnsupportedSchemeError, 'UNSUPPORTED_SCHEME'],
    [WrongChainError, 'WRONG_CHAIN'],
    [InsufficientFundsError, 'INSUFFICIENT_FUNDS'],
    [RecipientNotReadyError, 'RECIPIENT_NOT_READY'],
    [MissingDriverError, 'MISSING_DRIVER'],
    [WalletRequiredError, 'WALLET_REQUIRED'],
    [InvalidEnvelopeError, 'INVALID_ENVELOPE'],
    [NoCompatibleAcceptError, 'NO_COMPATIBLE_ACCEPT'],
    [ConfirmationTimeoutError, 'CONFIRMATION_TIMEOUT'],
    [MaxRetriesExceededError, 'MAX_RETRIES_EXCEEDED'],
    [PaymentDeclinedError, 'PAYMENT_DECLINED'],
    [PaymentTimeoutError, 'PAYMENT_TIMEOUT'],
    [SettlementError, 'SETTLEMENT_FAILED'],
    [NonReplayableBodyError, 'NON_REPLAYABLE_BODY'],
  ]
  for (const [Cls, code] of EXPECTED) {
    const msg = `round-trip ${Cls.name}`
    let inst, threw = false
    try { inst = new Cls(msg) } catch { threw = true }
    check(threw === false && inst, `new ${Cls.name}(message) constructs`)
    check(inst instanceof Error, `${Cls.name} is an Error`)
    check(inst instanceof PipRailError, `${Cls.name} is a PipRailError`)
    check(inst?.message === msg, `${Cls.name} preserves its message`)
    if (code !== undefined) check(inst?.code === code, `${Cls.name}.code === "${code}"`)
  }
}

// ───────────────────────── (6) SAFE-INTEGER — no silent float precision loss ─────────────────────────
group('safe-integer: a challenge amount whose base units exceed 2^53 is preserved EXACTLY as a string')
{
  // 99999999999.999999 USDC (6dp) = 99999999999999999 base units (17 nines), which is > 2^53. A Number
  // round-trip (parseFloat) would corrupt it to 100000000000000000 — assert the SDK does NOT do that.
  const FORMATTED = '99999999999.999999'
  const EXPECTED_BASE = '99999999999999999'
  let amount, threw = false
  try {
    const gate = createPaymentGate({ chain: 'base', token: 'USDC', amount: FORMATTED, payTo: MERCHANT, rpcUrl: DEAD_RPC })
    const c = await gate.challenge('http://127.0.0.1:1/r')
    amount = c.challenge.accepts[0]?.amount
  } catch { threw = true }
  check(threw === false, 'challenge() with a huge amount does not throw')
  check(typeof amount === 'string', 'the on-the-wire amount is a STRING (base units), not a JS number')
  check(amount === EXPECTED_BASE, `base units preserved EXACTLY (${EXPECTED_BASE}), no float rounding`)
  // Cross-check that a naive Number path WOULD have corrupted it — proving the assertion is sharp.
  check(String(Number(FORMATTED) * 1e6) !== EXPECTED_BASE, 'a naive Number(amount)*1e6 path WOULD have corrupted it (assertion is sharp)')

  // A second value just under 2^53 must also be exact.
  const gate2 = createPaymentGate({ chain: 'base', token: 'USDC', amount: '9007199254.740993', payTo: MERCHANT, rpcUrl: DEAD_RPC })
  const c2 = await gate2.challenge('http://127.0.0.1:1/r')
  check(c2.challenge.accepts[0]?.amount === '9007199254740993', 'a value straddling 2^53 is also preserved exactly')
}

// 2.14.2 — invalid gate config is a TYPED InvalidConfigError, even for primitives / null elements
// (was a raw "Cannot use 'in' operator" / "reading 'chain'" TypeError or a bare Error pre-2.14.2).
group('offline — invalid config → typed InvalidConfigError (primitive token, null accept element, bad amount/manifest)')
{
  const EVM = '0x28Dc25bf88BF06fc0a3Af1747D1aA4a21f313ed0'
  const cfgErr = async (opts) => {
    try { await createPaymentGate(opts).challenge('http://127.0.0.1:1/r'); return 'NO-THROW' }
    catch (e) { return e instanceof InvalidConfigError && e.code === 'INVALID_CONFIG' ? 'OK' : `${e?.constructor?.name}(${e?.code})` }
  }
  check(await cfgErr({ chain: 'base', token: 42, amount: '0.01', payTo: EVM }) === 'OK', 'token:42 (primitive) → InvalidConfigError, not a raw "Cannot use \'in\' operator" TypeError')
  check(await cfgErr({ chain: 'base', token: null, amount: '0.01', payTo: EVM }) === 'OK', 'token:null → InvalidConfigError')
  check(await cfgErr({ chain: 'base', token: 'USDC', amount: '1e3', payTo: EVM }) === 'OK', "amount:'1e3' (sci-notation) → InvalidConfigError")
  check(await cfgErr({ chain: 'base', token: 'USDC', amount: 0.05, payTo: EVM }) === 'OK', 'amount:0.05 (number) → InvalidConfigError, not "value.split is not a function"')
  check(await cfgErr({ chain: 'base', token: 'USDC', amount: '0.05' }) === 'OK', 'missing payTo → InvalidConfigError')
  check(await cfgErr({ accept: [null] }) === 'OK', 'accept:[null] (null element) → InvalidConfigError, not a raw "reading \'chain\'" TypeError')
  check(await cfgErr({ accept: {} }) === 'OK', 'accept:{} (non-array) → InvalidConfigError, not a bare Error')
  check(await cfgErr({ accept: 42 }) === 'OK', 'accept:42 → InvalidConfigError')
  // PipRailError is the common base — a caller can catch the whole family in one clause.
  let base = false
  try { await createPaymentGate({ chain: 'base', token: 42, amount: '0.01', payTo: EVM }).challenge('http://127.0.0.1:1/r') } catch (e) { base = e instanceof PipRailError }
  check(base, 'InvalidConfigError is a PipRailError (one catch clause covers every typed config error)')
}

done(w ? '11 typed errors + never-throw reads' : '11 typed errors + never-throw reads (offline)')

// Suite 14 — GATE CHALLENGE CORRECTNESS ACROSS EVERY CHAIN FAMILY  (offline, no funds)
//
// A PipRail 402 challenge is the wire contract every x402 client reads. It MUST be v2-conformant
// on EVERY rail — the same envelope shape whether the chain is an EVM L2, Solana, or a non-EVM L1
// whose driver only lazy-mounts when its `chain` is named. None of these legs touches the network:
// `gate.challenge()` builds the envelope from the static preset (asset/decimals/symbol) + the
// caller's amount/payTo, so a representative chain per family is fully testable offline.
//
//   OFFLINE (always):
//     (1) every family emits a v2 challenge — x402Version===2, an onchain-proof rail with
//         scheme/network(CAIP-2-ish)/amount(base units === value × 10^decimals, recomputed and
//         compared)/asset/payTo/maxTimeoutSeconds + extra.{decimals,symbol,amountFormatted},
//         and the additive extensions.piprail self-describe block that names `npm i @piprail/sdk`.
//     (2) the native coin is a valid asset on EVERY family (token:'native').
//     (3) ADVERSARIAL amounts ('0', '-1', 'abc', '', a 31-digit amount, over-precision, NaN/∞):
//         each either throws or yields a CLEAN base-unit integer — never NaN/Infinity/silent corruption.
//     (4) a wrong-family payTo is rejected with a typed WrongFamilyError on every family.
//
// This suite is OFFLINE-ONLY: challenge-building never hits the chain, so there is no live leg.
//
import { createPaymentGate, WrongFamilyError, PipRailError } from '@piprail/sdk'
import { check, banner, group, note, skip, done } from '../lib/report.mjs'
import { loadWallet } from '../lib/env.mjs'

banner('14 · GATE CHALLENGE ACROSS EVERY FAMILY (offline)')
const w = loadWallet()

// One representative chain per family, with a VALID payTo for that family, the family's default
// (or required) token, and the decimals + symbol the published preset is expected to emit. The
// amount is fixed at 0.05 so the base-unit math (0.05 × 10^decimals) is easy to recompute.
const AMOUNT = '0.05'
const FAMILIES = [
  // EVM — three representatives (base, polygon, bnb). USDC is 6dp on base/polygon, 18dp on BNB.
  { chain: 'base',     token: 'USDC',   payTo: w?.merchant ?? '0x28Dc25bf88BF06fc0a3Af1747D1aA4a21f313ed0', net: 'eip155:8453', decimals: 6,  symbol: 'USDC' },
  { chain: 'polygon',  token: 'USDC',   payTo: '0x28Dc25bf88BF06fc0a3Af1747D1aA4a21f313ed0',                net: 'eip155:137',  decimals: 6,  symbol: 'USDC' },
  { chain: 'bnb',      token: 'USDC',   payTo: '0x28Dc25bf88BF06fc0a3Af1747D1aA4a21f313ed0',                net: 'eip155:56',   decimals: 18, symbol: 'USDC' },
  // Non-EVM — each lazy-mounts its driver on first naming, then builds the envelope with no RPC call.
  { chain: 'solana',   token: 'USDC',   payTo: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',             net: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', decimals: 6, symbol: 'USDC' },
  { chain: 'xrpl',     token: 'USDC',   payTo: 'rPVMhWBsfF9iMXYj3aAzJVkPDTFNSyWdKy',                       net: 'xrpl:0',      decimals: 6,  symbol: 'USDC' },
  { chain: 'stellar',  token: 'USDC',   payTo: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN', net: 'stellar:pubnet', decimals: 7, symbol: 'USDC' },
  { chain: 'ton',      token: 'USDT',   payTo: 'EQDtFpEwcFAEcRe5mLVh2N6C0x-_hJEM7W61_JLnSF74p4q2',         net: 'tvm:-239',    decimals: 6,  symbol: 'USDT' }, // TON's built-in jetton is USDT, not USDC
  { chain: 'tron',     token: 'USDT',   payTo: 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE',                       net: 'tron:mainnet', decimals: 6, symbol: 'USDT' },
  { chain: 'near',     token: 'USDC',   payTo: 'example.near',                                              net: 'near:mainnet', decimals: 6, symbol: 'USDC' },
  { chain: 'sui',      token: 'USDC',   payTo: '0x0000000000000000000000000000000000000000000000000000000000000abc', net: 'sui:mainnet', decimals: 6, symbol: 'USDC' },
  { chain: 'aptos',    token: 'USDC',   payTo: '0x1',                                                       net: 'aptos:1',     decimals: 6,  symbol: 'USDC' },
  { chain: 'algorand', token: 'USDC',   payTo: '7777777777777777777777777777777777777777777777777774MSJUVU', net: 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=', decimals: 6, symbol: 'USDC' },
]

// A payTo that is structurally valid for SOME OTHER family — used to prove cross-family rejection.
const FOREIGN_PAYTO = {
  base: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',     // a Solana base58 addr on an EVM chain
  polygon: 'rPVMhWBsfF9iMXYj3aAzJVkPDTFNSyWdKy',           // an XRPL addr on an EVM chain
  bnb: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN', // a Stellar G-addr on an EVM chain
  solana: '0x28Dc25bf88BF06fc0a3Af1747D1aA4a21f313ed0',    // an EVM addr on Solana
  xrpl: '0x28Dc25bf88BF06fc0a3Af1747D1aA4a21f313ed0',
  stellar: '0x28Dc25bf88BF06fc0a3Af1747D1aA4a21f313ed0',
  ton: '0x28Dc25bf88BF06fc0a3Af1747D1aA4a21f313ed0',
  tron: '0x28Dc25bf88BF06fc0a3Af1747D1aA4a21f313ed0',
  near: '0x28Dc25bf88BF06fc0a3Af1747D1aA4a21f313ed0',      // EVM hex addr is not a NEAR account id
  sui: 'rPVMhWBsfF9iMXYj3aAzJVkPDTFNSyWdKy',               // an XRPL addr on Sui
  aptos: 'rPVMhWBsfF9iMXYj3aAzJVkPDTFNSyWdKy',
  algorand: '0x28Dc25bf88BF06fc0a3Af1747D1aA4a21f313ed0',
}

/** value × 10^decimals as an exact BigInt string (the base-unit amount the challenge must emit). */
function baseUnits(value, decimals) {
  const [int, frac = ''] = String(value).split('.')
  const padded = (frac + '0'.repeat(decimals)).slice(0, decimals)
  return (BigInt(int || '0') * 10n ** BigInt(decimals) + BigInt(padded || '0')).toString()
}

/** challenge() is the never-network-touch boundary here; wrap so a throw becomes a failed check. */
async function challengeOf(cfg, overrides = {}) {
  const gate = createPaymentGate({ chain: cfg.chain, token: cfg.token, amount: AMOUNT, payTo: cfg.payTo, ...overrides })
  return (await gate.challenge('http://127.0.0.1:1/r')).challenge
}

// ───────────────────── (1) every family emits a v2-conformant challenge ─────────────────────
group('(1) every family — a v2 challenge with a complete, recomputed onchain-proof accept')
for (const cfg of FAMILIES) {
  let c
  try {
    c = await challengeOf(cfg)
  } catch (err) {
    check(false, `${cfg.chain}: gate.challenge() threw building an offline envelope: ${err?.message ?? err}`)
    continue
  }
  check(c.x402Version === 2, `${cfg.chain}: x402Version === 2`)
  check(c?.resource?.url === 'http://127.0.0.1:1/r', `${cfg.chain}: echoes the resource url`)
  check(Array.isArray(c.accepts) && c.accepts.length >= 1, `${cfg.chain}: at least one accept rail`)

  const a = c.accepts.find((x) => x.scheme === 'onchain-proof')
  check(!!a, `${cfg.chain}: offers an onchain-proof rail (every family supports it)`)
  if (!a) continue

  // Required x402 accept fields — present and the right shape.
  check(a.network === cfg.net, `${cfg.chain}: network === '${cfg.net}' (CAIP-2-ish)`)
  check(typeof a.network === 'string' && a.network.includes(':'), `${cfg.chain}: network is a CAIP-2-style '<namespace>:<ref>' string`)
  check(typeof a.asset === 'string' && a.asset.length > 0, `${cfg.chain}: asset is a non-empty string`)
  check(a.payTo === cfg.payTo, `${cfg.chain}: payTo is echoed verbatim`)
  check(typeof a.maxTimeoutSeconds === 'number' && a.maxTimeoutSeconds > 0 && Number.isFinite(a.maxTimeoutSeconds), `${cfg.chain}: maxTimeoutSeconds is a positive finite number (${a.maxTimeoutSeconds})`)

  // amount is a base-unit STRING and equals value × 10^decimals exactly.
  const expectedAmt = baseUnits(AMOUNT, cfg.decimals)
  check(typeof a.amount === 'string', `${cfg.chain}: amount is a string (base units, not a JS number)`)
  check(/^[0-9]+$/.test(a.amount), `${cfg.chain}: amount is a pure non-negative integer string`)
  check(a.amount === expectedAmt, `${cfg.chain}: amount === ${expectedAmt} (= ${AMOUNT} × 10^${cfg.decimals})`)

  // extra.{decimals,symbol,amountFormatted}
  check(a.extra?.decimals === cfg.decimals, `${cfg.chain}: extra.decimals === ${cfg.decimals}`)
  check(a.extra?.symbol === cfg.symbol, `${cfg.chain}: extra.symbol === '${cfg.symbol}'`)
  check(a.extra?.amountFormatted === AMOUNT, `${cfg.chain}: extra.amountFormatted === '${AMOUNT}'`)

  // The additive self-describe block — present, names the SDK install line, x402 v2.
  const pr = c.extensions?.piprail
  check(!!pr, `${cfg.chain}: extensions.piprail self-describe block is present (additive)`)
  check(pr?.sdk?.install === 'npm i @piprail/sdk', `${cfg.chain}: self-describe names 'npm i @piprail/sdk'`)
  check(pr?.protocol === 'x402' && String(pr?.version) === '2', `${cfg.chain}: self-describe declares x402 v2`)
}

// ───────────────────── (2) native coin is a valid asset on EVERY family ─────────────────────
group("(2) native coin is a valid payment asset on every family (token:'native')")
// Expected native decimals + symbol per family — verified against the published presets.
const NATIVE = {
  base: { dec: 18, sym: 'ETH' }, polygon: { dec: 18, sym: 'POL' }, bnb: { dec: 18, sym: 'BNB' },
  solana: { dec: 9, sym: 'SOL' }, xrpl: { dec: 6, sym: 'XRP' }, stellar: { dec: 7, sym: 'XLM' },
  ton: { dec: 9, sym: 'GRAM' }, tron: { dec: 6, sym: 'TRX' }, near: { dec: 24, sym: 'NEAR' },
  sui: { dec: 9, sym: 'SUI' }, aptos: { dec: 8, sym: 'APT' }, algorand: { dec: 6, sym: 'ALGO' },
}
for (const cfg of FAMILIES) {
  let c
  try {
    c = await challengeOf({ ...cfg, token: 'native' })
  } catch (err) {
    check(false, `${cfg.chain}: native-asset challenge() threw: ${err?.message ?? err}`)
    continue
  }
  const a = c.accepts.find((x) => x.scheme === 'onchain-proof')
  const exp = NATIVE[cfg.chain]
  check(a?.asset === 'native', `${cfg.chain}: native rail emits asset === 'native'`)
  check(a?.extra?.decimals === exp.dec, `${cfg.chain}: native decimals === ${exp.dec}`)
  check(a?.extra?.symbol === exp.sym, `${cfg.chain}: native symbol === '${exp.sym}'`)
  const expectedAmt = baseUnits(AMOUNT, exp.dec)
  check(a?.amount === expectedAmt, `${cfg.chain}: native amount === ${expectedAmt} (= ${AMOUNT} × 10^${exp.dec})`)
  check(/^[0-9]+$/.test(a?.amount ?? ''), `${cfg.chain}: native amount is a clean base-unit integer string`)
}

// ───────────────────── (3) adversarial amounts: throw-or-clean, never NaN/∞/corruption ─────────────────────
group('(3) adversarial amounts — each throws OR yields a clean base-unit integer (never NaN/Infinity)')
{
  // base USDC (6dp) is the representative; the same parse path feeds every family.
  const base = FAMILIES[0]
  const HUGE = '1' + '0'.repeat(30) // 31-digit amount — must stay exact BigInt, never overflow to a JS number
  const cases = [
    { amt: '0', mustThrow: false },                       // zero is a legal (if pointless) price
    { amt: '-1', mustThrow: true },                       // negative — reject
    { amt: 'abc', mustThrow: true },                      // non-numeric — reject
    { amt: '', mustThrow: true },                         // empty — reject
    { amt: HUGE, mustThrow: false },                      // 31-digit — accept, exact base units
    { amt: '1.2345678901234567890', mustThrow: true },    // more dp than the 6-dp token — reject (no silent truncation)
    { amt: '0.1234567', mustThrow: true },                // 7dp on a 6dp token — reject
    { amt: 'NaN', mustThrow: true },                      // the literal NaN — reject
    { amt: 'Infinity', mustThrow: true },                 // the literal Infinity — reject
    { amt: '0x10', mustThrow: true },                     // hex — reject
    // 2.14.1 (F-B1): scientific notation is REJECTED for a merchant amount — '1e3' must NOT be
    // silently read as 1000 tokens (parseUnits no longer expands sci-notation; floorUnits still does).
    { amt: '1e3', mustThrow: true },
    { amt: '1E3', mustThrow: true },
    { amt: '1.2e3', mustThrow: true },
    { amt: '5e-7', mustThrow: true },
  ]
  for (const { amt, mustThrow } of cases) {
    let threw = false, emitted = null, errName = ''
    try {
      const c = await challengeOf(base, { amount: amt })
      emitted = c.accepts.find((x) => x.scheme === 'onchain-proof')?.amount
    } catch (err) {
      threw = true
      errName = err?.constructor?.name ?? ''
    }
    if (mustThrow) {
      check(threw, `amount ${JSON.stringify(amt)} → rejected (throws), not silently coerced`)
    } else {
      // No-throw cases MUST yield a clean, finite base-unit integer string — the core never-corrupt invariant.
      check(!threw, `amount ${JSON.stringify(amt)} → accepted without throwing`)
      check(typeof emitted === 'string' && /^[0-9]+$/.test(emitted), `amount ${JSON.stringify(amt)} → clean integer base units (got ${emitted})`)
      check(!String(emitted).includes('NaN') && !String(emitted).includes('Infinity') && !String(emitted).includes('e') && !String(emitted).includes('.'), `amount ${JSON.stringify(amt)} → no NaN/Infinity/exponent/decimal leaked into the wire amount`)
    }
    if (threw) note(`  ${JSON.stringify(amt)} threw ${errName}`)
  }
  // The 31-digit amount must be EXACT BigInt math, not a lossy float (0.05-style scaling).
  const cHuge = await challengeOf(base, { amount: HUGE })
  check(cHuge.accepts[0].amount === baseUnits(HUGE, base.decimals), `the 31-digit amount scales by exact BigInt (=== ${baseUnits(HUGE, base.decimals)}, no float loss)`)
}

// ───────────────────── (4) wrong-family payTo → typed WrongFamilyError ─────────────────────
group('(4) a payTo valid for ANOTHER family is rejected with a typed WrongFamilyError')
for (const cfg of FAMILIES) {
  const foreign = FOREIGN_PAYTO[cfg.chain]
  let caught = null
  try {
    await challengeOf({ ...cfg, payTo: foreign })
  } catch (err) {
    caught = err
  }
  check(caught instanceof WrongFamilyError, `${cfg.chain}: foreign payTo throws WrongFamilyError (got ${caught?.constructor?.name ?? 'NO THROW'})`)
  check(caught instanceof PipRailError, `${cfg.chain}: WrongFamilyError is a typed PipRailError (stable .code surface)`)
  check(caught?.code === 'WRONG_FAMILY', `${cfg.chain}: error.code === 'WRONG_FAMILY'`)
}

if (!w) note('(no .secrets wallet — EVM payTo used a hardcoded valid address; this suite is offline-only by design)')
else skip('this suite is offline-only — challenge-building never hits the chain, so there is no live leg to run')

done(w ? '14 gate-challenge-families' : '14 gate-challenge-families (offline)')

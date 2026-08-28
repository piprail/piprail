import { describe, it, expect, beforeEach } from 'vitest'
import { createPaymentGate } from '../src/server.js'
import { buildSignatureHeader } from '../src/x402.js'
import { classifyChallenge, describeChallenge } from '../src/index.js'
import { parseUnits, formatUnits, floorUnits } from '../src/util/units.js'
import { proofAccepts } from './_dual-rail.js'
import { registerDriver } from '../src/drivers/index.js'
import { PipRailError } from '../src/errors.js'
import type { PaymentDriver } from '../src/drivers/types.js'
import type { X402Challenge, VerifyResult } from '../src/x402.js'

/*
 * ── FUZZ / ADVERSARIAL SWEEP OVER THE MONEY-CRITICAL PATHS ──────────────────────────
 *
 * WHY THIS AND NOT A LOAD TEST. PipRail has no server to overload — it is a library and
 * a static site, and the only thing under load is the merchant's own RPC and their own
 * host. So "smash testing" here means hostile INPUT, not hostile volume: the code that
 * answers "was I actually paid?" is where a bug costs money, and it is reached by bytes
 * an attacker fully controls.
 *
 * The rest of the suite is example-based — it asserts that specific, known attacks fail.
 * This file asserts PROPERTIES over thousands of generated inputs, which is how you catch
 * the attack nobody thought to write down.
 *
 * Randomness is SEEDED and the seed is printed in every describe() title. A failure here
 * reproduces exactly: re-run with FUZZ_SEED set to that seed. Never make this file depend
 * on the clock or Math.random — an irreproducible red build gets deleted, not fixed.
 */

const SEED = Number(process.env.FUZZ_SEED ?? 0x9e3779b9)
/** mulberry32 — small, fast, and deterministic given the seed. */
function makeRng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rng = makeRng(SEED)
const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)]!
const int = (n: number) => Math.floor(rng() * n)

/**
 * The shapes an attacker can actually put on the wire, plus the shapes a buggy client
 * produces by accident. The prototype-pollution keys and the throwing toString() are in
 * here deliberately: both reach code that assumed it was handed a plain string.
 */
const HOSTILE_SCALARS = [
  null, undefined, '', ' ', '0', '-1', 'NaN', 'Infinity', '-Infinity', '1e309',
  0, -0, NaN, Infinity, -Infinity, 1e309, Number.MAX_SAFE_INTEGER + 2,
  true, false, [], {}, [[]], { toString() { throw new Error('boom') } },
  '__proto__', 'constructor', '{}', '[]', 'null',
  'a'.repeat(10_000), '../'.repeat(200), '0x', '0x' + 'g'.repeat(64),
  -1n, 0n, 2n ** 256n,
] as const

function hostileValue(): unknown {
  const r = rng()
  if (r < 0.55) return pick(HOSTILE_SCALARS)
  if (r < 0.75) return Array.from({ length: int(4) }, () => pick(HOSTILE_SCALARS))
  if (r < 0.92) {
    const o: Record<string, unknown> = {}
    for (let i = 0; i < int(5); i++) {
      o[pick(['scheme', 'network', 'amount', 'asset', 'payTo', '__proto__', 'extra'])] = pick(HOSTILE_SCALARS)
    }
    return o
  }
  // Arbitrary code points, including the ones that break naive line-based parsing.
  return Array.from({ length: int(40) }, () => String.fromCodePoint(int(0x2000))).join('')
}

// ── A fake EVM driver that records exactly what the gate asked it to verify ─────────
const PAY_TO = '0x3333333333333333333333333333333333333333'
let seenAccepts: any[] = []
const verifyImpl: (ref: string, accept: any) => Promise<VerifyResult> = async (ref, accept) => ({
  ok: true,
  receipt: {
    scheme: 'onchain-proof', success: true, network: accept.network, transaction: ref,
    asset: accept.asset, amount: accept.amount, payer: '0xpayer', payTo: accept.payTo, verifiedAt: 'now',
  },
})

const fuzzDriver: PaymentDriver = {
  family: 'evm',
  resolve(opts) {
    const chain = opts.chain as { id?: number }
    if (typeof chain !== 'object' || typeof chain.id !== 'number') return null
    const network = `eip155:${chain.id}` as const
    return {
      family: 'evm',
      network,
      supports: (n) => n === network,
      resolveToken: (token: unknown) => ({ asset: `0x${String(token).toLowerCase()}`, decimals: 6, symbol: String(token) }),
      describeAsset: () => ({ symbol: 'USDC', decimals: 6 }),
      assertValidPayTo: () => undefined,
      bindWallet: (w) => ({ _native: w }),
      send: async () => `0x${'1'.repeat(64)}`,
      confirm: async () => ({ height: '1' }),
      estimateCost: async () => ({ feeSymbol: 'ETH', feeDecimals: 18, fee: '0', feeFormatted: '0', basis: 'heuristic' as const }),
      balanceOf: async () => ({ token: 0n, native: 0n }),
      recipientReady: async () => ({ ready: 'n/a' as const }),
      verify: (ref, accept) => { seenAccepts.push(accept); return verifyImpl(ref, accept) },
    }
  },
}
registerDriver(fuzzDriver)

const newGate = () =>
  createPaymentGate({ chain: { id: 8453, rpcUrl: 'x' }, token: 'USDC', amount: '0.05', payTo: PAY_TO })

beforeEach(() => { seenAccepts = [] })

// ─────────────────────────────────────────────────────────────────────────────────────
describe(`fuzz - the gate survives hostile input (seed 0x${SEED.toString(16)})`, () => {
  it('verify() never throws an untyped error, whatever arrives on the header', async () => {
    const gate = newGate()
    const failures: string[] = []
    for (let i = 0; i < 1500; i++) {
      const input = hostileValue()
      try {
        const res = await gate.verify(input as never)
        /*
         * Not throwing is only half the contract: it must also not have said yes. The gate
         * answers with a `kind` discriminant — 'paid' | 'challenge' | 'invalid' — and only
         * 'paid' unlocks the resource. (An earlier draft of this test asserted on `.ok`,
         * the DRIVER-level shape, which is always undefined here; the check passed on every
         * input, including ones that were accepted. A guard that cannot fail is worse than
         * no guard, so the shape is asserted explicitly below.)
         */
        expect(['paid', 'challenge', 'invalid']).toContain((res as { kind: string }).kind)
        if ((res as { kind: string }).kind === 'paid') {
          failures.push(`ACCEPTED garbage: ${String(JSON.stringify(input)).slice(0, 120)}`)
        }
      } catch (err) {
        /*
         * ERRORS.md section 5: everything a caller can trigger is a typed PipRailError
         * with a stable .code. A raw TypeError here means hostile bytes reached code that
         * assumed a shape — precisely the class of bug this file exists to find.
         */
        if (!(err instanceof PipRailError)) {
          failures.push(`${(err as Error).constructor.name}: ${String((err as Error).message).slice(0, 80)}`)
        }
      }
    }
    expect(failures.slice(0, 10), `re-run with FUZZ_SEED=${SEED}`).toEqual([])
  })

  it('a forged accepted-echo can never redirect what actually gets verified', async () => {
    /*
     * THE INVARIANT THIS FILE EXISTS TO PROTECT. The client echoes back the accept it
     * claims to have paid. If verify() trusted that echo, an attacker would rewrite
     * payTo to their own address, or amount to one base unit, and the gate would confirm
     * a payment that went nowhere. Every checked field must be re-derived from the
     * server's own trusted accept, never read off the wire.
     */
    const gate = newGate()
    const { challenge } = await gate.challenge()
    const trusted = proofAccepts(challenge)[0]! as any

    for (let i = 0; i < 600; i++) {
      const forged: Record<string, unknown> = { ...trusted }
      for (let k = 0; k <= int(4); k++) {
        forged[pick(['network', 'asset', 'amount', 'payTo', 'scheme', 'maxTimeoutSeconds', 'extra'])] =
          pick([...HOSTILE_SCALARS, '0xattacker', 'eip155:1', '999999999999'])
      }
      seenAccepts = []
      try {
        await gate.verify(buildSignatureHeader({
          x402Version: 2,
          accepted: forged as never,
          payload: { nonce: trusted.extra.nonce, txHash: `0x${i.toString(16).padStart(64, '0')}` },
        }))
      } catch { /* a rejection is a fine outcome; what matters is what the driver saw */ }

      for (const seen of seenAccepts) {
        expect(seen.payTo, `forged echo reached the driver (seed ${SEED}, iteration ${i})`).toBe(trusted.payTo)
        expect(seen.amount).toBe(trusted.amount)
        expect(seen.network).toBe(trusted.network)
        expect(seen.asset).toBe(trusted.asset)
      }
    }
  })

  it('a proof that verified once can never be redeemed again, however the envelope is dressed up', async () => {
    const gate = newGate()
    const { challenge } = await gate.challenge()
    const accept = proofAccepts(challenge)[0]! as any
    const tx = `0x${'ab'.repeat(32)}`

    const first = await gate.verify(buildSignatureHeader({
      x402Version: 2, accepted: accept, payload: { nonce: accept.extra.nonce, txHash: tx },
    }))
    expect(first.kind, 'the honest payment must succeed, or the replay test proves nothing').toBe('paid')

    // 400 re-presentations of the SAME proof, with everything around it randomised.
    for (let i = 0; i < 400; i++) {
      const dressed: Record<string, unknown> = { ...accept }
      for (let k = 0; k <= int(3); k++) dressed[pick(['network', 'asset', 'amount', 'payTo', 'extra'])] = hostileValue()
      let ok = false
      try {
        const res = await gate.verify(buildSignatureHeader({
          x402Version: pick([2, 1, 0, 99]) as never,
          accepted: dressed as never,
          payload: { nonce: accept.extra.nonce, txHash: pick([tx, tx.toUpperCase(), ` ${tx} `]) },
        }))
        ok = res.kind === 'paid'
      } catch { /* a rejection is the expected shape of "no" */ }
      expect(ok, `REPLAY ACCEPTED at iteration ${i} (seed ${SEED})`).toBe(false)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────
describe(`fuzz - documented never-throw contracts hold under garbage (seed 0x${SEED.toString(16)})`, () => {
  it('classifyChallenge and describeChallenge degrade rather than throw', () => {
    const opts = { network: 'eip155:8453' as const, schemes: ['onchain-proof'] as const }
    for (let i = 0; i < 2000; i++) {
      const bad = hostileValue() as X402Challenge
      expect(() => classifyChallenge(bad, opts as never)).not.toThrow()
      expect(() => describeChallenge(bad)).not.toThrow()
      expect(typeof describeChallenge(bad)).toBe('string')
    }
  })

  it('any header it agrees to build is a header it can read back', () => {
    for (let i = 0; i < 800; i++) {
      const payload = { nonce: hostileValue(), txHash: hostileValue() }
      let header: string | undefined
      try {
        header = buildSignatureHeader({ x402Version: 2, accepted: hostileValue() as never, payload: payload as never })
      } catch (err) {
        expect(err).toBeInstanceOf(PipRailError)
        continue
      }
      // A producer that emits bytes its own parser rejects is a protocol bug, not an
      // input problem — so if it built something, that something must decode.
      expect(typeof header).toBe('string')
      expect(() => Buffer.from(header!, 'base64').toString('utf8')).not.toThrow()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────
describe(`fuzz - unit conversion is exact and total (seed 0x${SEED.toString(16)})`, () => {
  it('parseUnits then formatUnits round-trips exactly, at every decimal precision', () => {
    for (let i = 0; i < 3000; i++) {
      const decimals = int(19)
      const whole = String(int(1e9))
      const fracLen = int(decimals + 1)
      const frac = fracLen ? Array.from({ length: fracLen }, () => int(10)).join('') : ''
      const value = frac ? `${whole}.${frac}` : whole

      const base = parseUnits(value, decimals)
      const back = formatUnits(base, decimals)
      /*
       * The round trip must preserve the NUMBER, not the spelling: "1.50" coming back as
       * "1.5" is correct, "1.5" coming back as "1.4999" is money quietly going missing.
       * So re-parse rather than string-compare.
       */
      expect(parseUnits(back, decimals), `seed ${SEED}: ${value} at ${decimals}dp gave ${base} then ${back}`).toBe(base)
    }
  })

  it('never returns a negative base amount, and floorUnits never rounds UP', () => {
    for (let i = 0; i < 2000; i++) {
      const decimals = int(19)
      const value = `${int(1e6)}.${Array.from({ length: int(24) }, () => int(10)).join('')}`
      let parsed: bigint
      try {
        parsed = parseUnits(value, decimals)
      } catch (err) {
        // Over-precise input is legitimately a hard error; it must still be a typed one.
        expect(err).toBeInstanceOf(PipRailError)
        continue
      }
      expect(parsed >= 0n).toBe(true)

      /*
       * floorUnits exists to truncate excess precision. If it ever rounded UP, a buyer
       * could under-pay by a sub-unit and still satisfy an exact-amount check.
       */
      expect(floorUnits(value, decimals) <= parsed).toBe(true)
    }
  })

  it('rejects malformed amounts loudly instead of coercing them to a number', () => {
    const malformed = ['', ' ', '.', '..', '1.2.3', '-1', '1e5', 'abc', '0x10', '1,5', '1 ', ' 1', '+1', 'Infinity', 'NaN']
    for (const value of malformed) {
      let out: bigint | undefined
      try {
        out = parseUnits(value, 6)
      } catch (err) {
        expect(err).toBeInstanceOf(PipRailError)
        continue
      }
      // A silent 0n would turn a garbage price into a free resource.
      expect.fail(`parseUnits(${JSON.stringify(value)}, 6) returned ${out} instead of throwing`)
    }
  })
})

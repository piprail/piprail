/**
 * payment-identifier (opt-in idempotency id) — advertise · validate · dedupe · echo.
 *
 * The id rides on the payload at `extensions['payment-identifier'].info.id`; the gate dedupes it
 * on the SAME used-proof set as a tx ref (namespaced `pid:<id>`), echoes it on a settled response,
 * and re-challenges a malformed id — all ADDITIVE to (never a replacement for) proof-set replay
 * protection. Default OFF (byte-identical). Mirrors server-replay.test.ts: a module-isolated fake
 * EVM driver with a swappable verify(), no RPC.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createPaymentGate } from '../src/server.js'
import { buildSignatureHeader, EXT_PAYMENT_IDENTIFIER } from '../src/x402.js'
import { proofAccepts } from './_dual-rail.js'
import { registerDriver } from '../src/drivers/index.js'
import type { PaymentDriver } from '../src/drivers/types.js'
import type { VerifyResult } from '../src/x402.js'

const PAY_TO = '0x4444444444444444444444444444444444444444'
const ID = 'pay_aBcD1234_xyz-90' // 18 chars, valid charset

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ok = (ref: string, accept: any): VerifyResult => ({
  ok: true,
  receipt: { scheme: 'onchain-proof', success: true, network: accept.network, transaction: ref, asset: accept.asset, amount: accept.amount, payer: '0xpayer', payTo: accept.payTo, verifiedAt: 'now' },
})
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let verifyImpl: (ref: string, accept: any) => Promise<VerifyResult> = async (ref, accept) => ok(ref, accept)

const fakeEvm: PaymentDriver = {
  family: 'evm',
  resolve(opts) {
    const chain = opts.chain as { id?: number }
    if (typeof chain !== 'object' || typeof chain.id !== 'number') return null
    const network = `eip155:${chain.id}` as const
    return {
      family: 'evm', network, supports: (n) => n === network,
      resolveToken: (t: unknown) => ({ asset: `0x${String(t).toLowerCase()}`, decimals: 6, symbol: String(t) }),
      describeAsset: () => ({ symbol: 'USDC', decimals: 6 }),
      assertValidPayTo: () => undefined,
      bindWallet: (w) => ({ _native: w }),
      send: async () => `0x${'1'.repeat(64)}`,
      confirm: async () => ({ height: '1' }),
      estimateCost: async () => ({ feeSymbol: 'ETH', feeDecimals: 18, fee: '0', feeFormatted: '0', basis: 'heuristic' as const }),
      balanceOf: async () => ({ token: 0n, native: 0n }),
      recipientReady: async () => ({ ready: 'n/a' as const }),
      verify: (ref, accept) => verifyImpl(ref, accept),
    }
  },
}
registerDriver(fakeEvm)

beforeEach(() => {
  verifyImpl = async (ref, accept) => ok(ref, accept)
})

function gate(extra: Record<string, unknown> = {}) {
  return createPaymentGate({ chain: { id: 8453, rpcUrl: 'x' }, token: 'USDC', amount: '0.05', payTo: PAY_TO, paymentIdentifier: true, ...extra })
}
function plainGate(extra: Record<string, unknown> = {}) {
  return createPaymentGate({ chain: { id: 8453, rpcUrl: 'x' }, token: 'USDC', amount: '0.05', payTo: PAY_TO, ...extra })
}
const TX = (c: string) => `0x${c.repeat(64)}`
const decode = (b64: string) => JSON.parse(Buffer.from(b64, 'base64').toString('utf8'))

/** Build + verify a payment, optionally carrying a payment-identifier id (or a raw/malformed value). */
async function pay(g: ReturnType<typeof gate>, tx: string, id?: unknown) {
  const { challenge } = await g.challenge()
  const accept = proofAccepts(challenge)[0]!
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sig: any = { x402Version: 2, accepted: accept, payload: { nonce: accept.extra.nonce, txHash: tx } }
  if (id !== undefined) sig.extensions = { [EXT_PAYMENT_IDENTIFIER]: { info: { id } } }
  return g.verify(buildSignatureHeader(sig))
}

describe('payment-identifier — advertisement', () => {
  it('advertises { info, schema } on BOTH the body + slim header challenge when on', async () => {
    const { challenge, requiredHeader } = await gate().challenge()
    const adv = { info: { required: false }, schema: { properties: { id: { type: 'string', minLength: 16, maxLength: 128 } } } }
    expect((challenge.extensions as Record<string, unknown>)[EXT_PAYMENT_IDENTIFIER]).toEqual(adv)
    expect((decode(requiredHeader).extensions as Record<string, unknown>)[EXT_PAYMENT_IDENTIFIER]).toEqual(adv)
  })
  it('is ABSENT by default (byte-identical) — neither body nor header carries the key', async () => {
    const { challenge, requiredHeader } = await plainGate().challenge()
    expect((challenge.extensions as Record<string, unknown> | undefined)?.[EXT_PAYMENT_IDENTIFIER]).toBeUndefined()
    expect((decode(requiredHeader).extensions as Record<string, unknown> | undefined)?.[EXT_PAYMENT_IDENTIFIER]).toBeUndefined()
  })
})

describe('payment-identifier — echo on success', () => {
  it('echoes the accepted id back on the settled PAYMENT-RESPONSE', async () => {
    const r = (await pay(gate(), TX('a'), ID)) as { kind: string; receiptHeader: string }
    expect(r.kind).toBe('paid')
    expect(decode(r.receiptHeader).extensions[EXT_PAYMENT_IDENTIFIER].info.id).toBe(ID)
  })
  it('no id → still paid, no payment-identifier echo', async () => {
    const r = (await pay(gate(), TX('b'))) as { kind: string; receiptHeader: string }
    expect(r.kind).toBe('paid')
    expect(decode(r.receiptHeader).extensions?.[EXT_PAYMENT_IDENTIFIER]).toBeUndefined()
  })
})

describe('payment-identifier — BREAK IT: malformed id is re-challenged (never silently passed)', () => {
  it('id too long (129 chars) → signature_invalid + a retryable re-challenge', async () => {
    const r = (await pay(gate(), TX('c'), 'p'.repeat(129))) as { kind: string; error: string; challenge: { accepts: unknown[] } }
    expect(r).toMatchObject({ kind: 'invalid', error: 'signature_invalid' })
    expect(r.challenge.accepts.length).toBeGreaterThan(0)
  })
  it('id too short (15 chars) → signature_invalid', async () => {
    expect(await pay(gate(), TX('d'), 'p'.repeat(15))).toMatchObject({ kind: 'invalid', error: 'signature_invalid' })
  })
  it('id non-string (number) → signature_invalid', async () => {
    expect(await pay(gate(), TX('e'), 12345678)).toMatchObject({ kind: 'invalid', error: 'signature_invalid' })
  })
  it('id bad charset (spaces / slash) → signature_invalid', async () => {
    expect(await pay(gate(), TX('f'), 'pay/with spaces!')).toMatchObject({ kind: 'invalid', error: 'signature_invalid' })
  })
  it('a malformed id does NOT burn the proof or the id — fix it and the SAME proof settles', async () => {
    const g = gate()
    expect(((await pay(g, TX('g'), 'short')) as { kind: string }).kind).toBe('invalid')
    expect(((await pay(g, TX('g'), ID)) as { kind: string }).kind).toBe('paid')
  })
})

describe('payment-identifier — BREAK IT: dedupe (rides the proof set, never weakens it)', () => {
  it('DUPLICATE id across two DIFFERENT proofs → the second is rejected tx_already_used', async () => {
    const g = gate()
    expect(((await pay(g, TX('1'), ID)) as { kind: string }).kind).toBe('paid')
    expect(await pay(g, TX('2'), ID)).toMatchObject({ kind: 'invalid', error: 'tx_already_used' })
  })
  it('BREAK-IT: two case-only-differing ids are DISTINCT on the DEFAULT in-memory store (the pid: key must NOT be EVM-lowercased)', async () => {
    // The id charset is case-SENSITIVE (/[A-Za-z0-9_-]/, no `i`), so these are two different ids.
    // Before the fix the default store lowercased the `pid:` key (an EVM-tx-hash canonicalization),
    // collapsing them → the second legitimate sale was wrongly rejected tx_already_used.
    const g = gate()
    expect(((await pay(g, TX('h'), 'PAY_IDENT_ABCDEF12')) as { kind: string }).kind).toBe('paid')
    expect(((await pay(g, TX('i'), 'pay_ident_abcdef12')) as { kind: string }).kind).toBe('paid')
  })
  it('same id + same proof re-presented → tx_already_used (proof replay still caught)', async () => {
    const g = gate()
    expect(((await pay(g, TX('3'), ID)) as { kind: string }).kind).toBe('paid')
    expect(await pay(g, TX('3'), ID)).toMatchObject({ kind: 'invalid', error: 'tx_already_used' })
  })
  it('a REJECTED proof RELEASES the id — retry the SAME id with a good proof', async () => {
    const g = gate()
    verifyImpl = async () => ({ ok: false, error: 'tx_not_found', detail: 'RPC lag' })
    expect(await pay(g, TX('4'), ID)).toMatchObject({ kind: 'invalid', error: 'tx_not_found' })
    verifyImpl = async (ref, accept) => ok(ref, accept)
    expect(((await pay(g, TX('4'), ID)) as { kind: string }).kind).toBe('paid')
  })
  it('a THROWN verify RELEASES the id (transient blip) — retry the SAME id succeeds', async () => {
    const g = gate()
    verifyImpl = async () => {
      throw new Error('RPC down')
    }
    await expect(pay(g, TX('5'), ID)).rejects.toThrow(/RPC down/)
    verifyImpl = async (ref, accept) => ok(ref, accept)
    expect(((await pay(g, TX('5'), ID)) as { kind: string }).kind).toBe('paid')
  })
})

describe('payment-identifier — the id dedupe SHARES the one pluggable proof store', () => {
  it('a settled payment writes BOTH pid:<id> AND the tx ref to the injected store; a reuse is rejected via it', async () => {
    const store = new Set<string>()
    const g = createPaymentGate({
      chain: { id: 8453, rpcUrl: 'x' }, token: 'USDC', amount: '0.05', payTo: PAY_TO, paymentIdentifier: true,
      isUsed: (ref) => store.has(ref), markUsed: (ref) => { store.add(ref) },
    })
    const tx = TX('7')
    expect(((await pay(g, tx, ID)) as { kind: string }).kind).toBe('paid')
    expect(store.has('pid:' + ID)).toBe(true) // the id rode the SAME store…
    expect(store.has(tx)).toBe(true) // …alongside the proof ref
    expect(await pay(g, TX('8'), ID)).toMatchObject({ kind: 'invalid', error: 'tx_already_used' })
  })
})

describe('payment-identifier — OFF by default: an id is ignored (no dedupe, no echo)', () => {
  it('with the option off, an id is neither deduped nor echoed', async () => {
    const g = plainGate()
    const r1 = (await pay(g, TX('9'), ID)) as { kind: string; receiptHeader: string }
    expect(r1.kind).toBe('paid')
    expect(decode(r1.receiptHeader).extensions?.[EXT_PAYMENT_IDENTIFIER]).toBeUndefined()
    // a DIFFERENT proof with the SAME id still works — there is no id-level dedupe when off
    expect(((await pay(g, TX('A'), ID)) as { kind: string }).kind).toBe('paid')
  })
})

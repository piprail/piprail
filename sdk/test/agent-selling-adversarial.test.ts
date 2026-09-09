/**
 * ── ATTACKING THE EARNING HALF ───────────────────────────────────────────────────────
 *
 * `agent-selling.test.ts` pins the happy path and the obvious refusals. This file assumes a
 * hostile buyer and asks what they could take.
 *
 * The seller side has a different threat model from the buyer side, and a worse failure: a
 * buyer who overpays loses money, but a SELLER who mis-verifies hands over goods for nothing
 * and cannot claw them back. Every test here is a way of getting delivery without paying for
 * it, or of getting paid once and collecting twice.
 */
import { describe, it, expect } from 'vitest'
import { PipRailClient, paymentTools, type AgentTool } from '../src/index.js'
import { buildSignatureHeader } from '../src/x402.js'
import { firstProof } from './_dual-rail.js'
import { registerDriver } from '../src/drivers/index.js'
import type { PaymentDriver } from '../src/drivers/types.js'
import type { X402Challenge } from '../src/x402.js'

process.env.PIPRAIL_NO_HINTS = '1'

const MINE = '0xA6E17A6E17A6E17A6E17A6E17A6E17A6E17A6E17'
const ATTACKER = '0xBADBADBADBADBADBADBADBADBADBADBADBADBADB'
const CHAIN = { id: 8453, rpcUrl: 'https://fake.example/rpc' }

/** Records exactly which accept the driver was asked to verify, so we can prove what was trusted. */
const seen: Array<{ ref: string; payTo: string; amount: string }> = []

/** The pretend chain: what each tx hash ACTUALLY paid, and to whom. */
const CHAIN_LEDGER = new Map<string, { payTo: string; amount: string }>()
const pays = (tx: string, payTo: string, amount: string) => {
  CHAIN_LEDGER.set(tx, { payTo, amount })
  return tx
}

const fakeEvm: PaymentDriver = {
  family: 'evm',
  resolve(opts) {
    const chain = opts.chain as { id?: number }
    if (typeof chain !== 'object' || typeof chain.id !== 'number') return null
    const network = `eip155:${chain.id}` as const
    return {
      family: 'evm',
      network,
      supports: (n) => n === network,
      resolveToken: (t) => {
        const sym = typeof t === 'string' ? t.toUpperCase() : 'USDC'
        if (sym !== 'USDC' && sym !== 'NATIVE') throw new Error(`unknown token ${sym}`)
        return sym === 'NATIVE' ? { asset: 'native', decimals: 18, symbol: 'ETH' } : { asset: '0xUSDC', decimals: 6, symbol: 'USDC' }
      },
      describeAsset: () => ({ symbol: 'USDC', decimals: 6 }),
      assertValidPayTo: () => undefined,
      bindWallet: (w) => ({ _native: w }),
      send: async () => `0x${'1'.repeat(64)}`,
      confirm: async () => ({ height: '1' }),
      estimateCost: async () => ({ feeSymbol: 'ETH', feeDecimals: 18, fee: '0', feeFormatted: '0', basis: 'heuristic' as const }),
      addressOf: async () => MINE,
      balanceOf: async () => ({ token: 0n, native: 0n }),
      recipientReady: async () => ({ ready: 'n/a' as const }),
      /*
       * A FAITHFUL driver, not a rubber stamp. It models the chain: a tx only verifies if the
       * ledger below actually records a transfer of at least `accept.amount` to `accept.payTo`.
       * A driver that always said yes would hide every question worth asking here.
       */
      verify: async (ref, accept) => {
        seen.push({ ref, payTo: accept.payTo, amount: accept.amount })
        const tx = CHAIN_LEDGER.get(ref)
        if (!tx || tx.payTo !== accept.payTo || BigInt(tx.amount) < BigInt(accept.amount)) {
          return { ok: false, error: 'transfer_not_found' as const, detail: `no transfer >= ${accept.amount} to ${accept.payTo} in ${ref}` }
        }
        return {
          ok: true,
          receipt: {
            scheme: 'onchain-proof', success: true, network: accept.network, transaction: ref,
            asset: accept.asset, amount: accept.amount, payer: '0xpayer', payTo: accept.payTo, verifiedAt: 'now',
          },
        }
      },
    }
  },
}
registerDriver(fakeEvm)

type Res = Record<string, unknown>
const kit = (): Record<string, AgentTool> =>
  Object.fromEntries(
    paymentTools(
      new PipRailClient({ chain: CHAIN, wallet: { key: '0xk' }, mode: 'sovereign', swapPolicy: { maxPerSwap: '9' } } as never)
    ).map((t) => [t.name, t])
  )

const sell = async (T: Record<string, AgentTool>, over: Res = {}) =>
  (await T.piprail_sell!.invoke({ description: 'a thing', price: '1.00', ...over })) as Res

/** A proof a buyer would return for `challenge`, with optional tampering. */
const proofFor = (challenge: X402Challenge, tamper: (a: Record<string, unknown>) => Record<string, unknown> = (a) => a, tx = `0x${'a'.repeat(64)}`) => {
  const accepted = tamper({ ...firstProof(challenge) }) as unknown as ReturnType<typeof firstProof>
  return buildSignatureHeader({ x402Version: 2, accepted, payload: { nonce: accepted.extra!.nonce, txHash: tx } })
}

describe('a hostile buyer cannot get delivery for free', () => {
  it('REFUSES a cheap proof presented against an expensive offer', async () => {
    const T = kit()
    const cheap = await sell(T, { price: '0.01' })
    const dear = await sell(T, { price: '500.00' })
    const tx = pays(`0x${'c'.repeat(64)}`, String(cheap.payTo), '10000') // 0.01 USDC, really paid
    const stolen = (await T.piprail_collect!.invoke({
      offerId: dear.offerId,
      payment: proofFor(cheap.challenge as X402Challenge, (a) => a, tx),
    })) as Res
    expect(stolen.paid).toBe(false)
    expect(String(stolen.next)).toMatch(/do NOT deliver/i)
  })

  it('🔴 REFUSES a proof from another offer at the SAME price', async () => {
    /*
     * The attack the amount check cannot see. Two things listed at one price, to one address:
     * pay for the cheap-to-produce one, then present that same settlement against the other.
     * Every field a driver inspects matches, because they are the same price to the same payee.
     * Only the NONCE distinguishes them, so only the nonce can stop this.
     */
    const T = kit()
    const a = await sell(T, { description: 'a haiku', price: '1.00' })
    const b = await sell(T, { description: 'my private key material', price: '1.00' })
    const tx = pays(`0x${'d'.repeat(64)}`, String(a.payTo), '1000000') // ONE real payment, for A

    const forA = (await T.piprail_collect!.invoke({ offerId: a.offerId, payment: proofFor(a.challenge as X402Challenge, (x) => x, tx) })) as Res
    expect(forA.paid).toBe(true) // the buyer genuinely paid for A

    // …and must not also be handed B for the same money.
    const forB = (await T.piprail_collect!.invoke({ offerId: b.offerId, payment: proofFor(a.challenge as X402Challenge, (x) => x, tx) })) as Res
    expect(forB.paid).toBe(false)
  })

  it('🔴 one settlement is DEAD everywhere once redeemed, not just on the offer that took it', async () => {
    /*
     * The second layer, and the one that has to hold when a nonce cannot tell the offers apart
     * (a standard `exact` authorization carries the BUYER's nonce, not the challenge's). Here
     * the attacker does the work properly: they take the real settlement and re-present it
     * quoting offer B's OWN nonce, so the binding check above has nothing to object to.
     *
     * A gate's replay set is scoped to its own gate, so before the store owned this set, offer B
     * had simply never seen the tx and happily counted it as a fresh payment.
     */
    const T = kit()
    const a = await sell(T, { description: 'a haiku', price: '1.00' })
    const b = await sell(T, { description: 'the good stuff', price: '1.00' })
    const tx = pays(`0x${'f'.repeat(64)}`, String(a.payTo), '1000000') // ONE payment

    const first = (await T.piprail_collect!.invoke({ offerId: a.offerId, payment: proofFor(a.challenge as X402Challenge, (x) => x, tx) })) as Res
    expect(first.paid).toBe(true)

    // Same money, re-presented against B under B's own nonce: nothing for the binding check to
    // catch, so only a SHARED used-proof set can refuse it.
    const laundered = (await T.piprail_collect!.invoke({ offerId: b.offerId, payment: proofFor(b.challenge as X402Challenge, (x) => x, tx) })) as Res
    expect(laundered.paid).toBe(false)
    expect(String(laundered.reason)).toMatch(/used|already|replay/i)

    // And the books agree: one payment, one sale.
    const earnings = (await T.piprail_earnings!.invoke({})) as Res
    expect(earnings.collected).toBe(1)
  })

  it('🔴 REFUSES the wrong offer FIRST, where a used-proof set cannot help', async () => {
    /*
     * The sharpest version, and the one that needs the nonce.
     *
     * A buyer pays the challenge for the cheap offer, then presents that settlement against the
     * expensive one BEFORE collecting the cheap one. Nothing has been redeemed yet, so the used
     * set is empty and has no opinion; the amount and payee match because the prices match. The
     * only thing that knows this money was not for this offer is the nonce.
     */
    const T = kit()
    const haiku = await sell(T, { description: 'a haiku', price: '1.00' })
    const secrets = await sell(T, { description: 'the good stuff', price: '1.00' })
    const tx = pays(`0x${'9'.repeat(64)}`, String(haiku.payTo), '1000000') // paid for the HAIKU

    // Straight at the expensive offer, first, with the haiku's proof.
    const stolen = (await T.piprail_collect!.invoke({
      offerId: secrets.offerId,
      payment: proofFor(haiku.challenge as X402Challenge, (x) => x, tx),
    })) as Res
    expect(stolen.paid).toBe(false)
    expect(String(stolen.code)).toBe('wrong_offer')

    // The honest collection still works afterwards: refusing a theft must not burn the payment.
    const honest = (await T.piprail_collect!.invoke({
      offerId: haiku.offerId,
      payment: proofFor(haiku.challenge as X402Challenge, (x) => x, tx),
    })) as Res
    expect(honest.paid).toBe(true)
  })

  it('gives every offer its own nonce, so proofs cannot be shuffled between them', async () => {
    const T = kit()
    const a = await sell(T)
    const b = await sell(T)
    const nonce = (o: Res) => firstProof(o.challenge as X402Challenge).extra!.nonce
    expect(nonce(a)).not.toBe(nonce(b))
  })

  it('IGNORES a forged echo: the gate verifies its OWN payTo, never the buyer’s', async () => {
    /*
     * The buyer echoes back the accept they claim to have paid. If the gate trusted that echo,
     * a buyer could rewrite `payTo` to their own address, pay THEMSELVES, and present a
     * perfectly real on-chain transfer as proof.
     */
    const T = kit()
    const offer = await sell(T)
    seen.length = 0
    await T.piprail_collect!.invoke({
      offerId: offer.offerId,
      payment: proofFor(offer.challenge as X402Challenge, (a) => ({ ...a, payTo: ATTACKER })),
    })
    expect(seen.length).toBeGreaterThan(0)
    // Whatever the buyer echoed, the driver was asked about the SELLER's address.
    for (const s of seen) expect(s.payTo).not.toBe(ATTACKER)
    expect(seen[0]!.payTo).toBe(offer.payTo)
  })

  it('IGNORES a forged amount: it verifies the price it set, not the price claimed', async () => {
    const T = kit()
    const offer = await sell(T, { price: '100.00' })
    seen.length = 0
    await T.piprail_collect!.invoke({
      offerId: offer.offerId,
      payment: proofFor(offer.challenge as X402Challenge, (a) => ({ ...a, amount: '1' })),
    })
    // 100.00 USDC at 6dp. A gate that trusted the echo would have checked for 1 base unit.
    expect(seen[0]!.amount).toBe('100000000')
  })

  it('keeps offers isolated: collecting on one earns nothing on another', async () => {
    const T = kit()
    const a = await sell(T, { price: '1.00' })
    const b = await sell(T, { price: '2.00' })
    const tx = pays(`0x${'e'.repeat(64)}`, String(a.payTo), '1000000')
    await T.piprail_collect!.invoke({ offerId: a.offerId, payment: proofFor(a.challenge as X402Challenge, (x) => x, tx) })
    const earnings = (await T.piprail_earnings!.invoke({})) as Res
    const rows = earnings.offers as Array<Record<string, unknown>>
    expect(rows.find((r) => r.offerId === a.offerId)!.timesPaid).toBe(1)
    expect(rows.find((r) => r.offerId === b.offerId)!.timesPaid).toBe(0)
  })

  it('cannot be talked into paying the buyer’s own address by the SELL call either', async () => {
    // The other direction: an agent persuaded to list an offer that pays somebody else. It is
    // allowed (an operator may genuinely want it) but must be reported, never silent.
    const T = kit()
    const offer = await sell(T, { payTo: ATTACKER })
    expect(offer.payTo).toBe(ATTACKER)
    expect(offer.paidToYou).toBe(false)
  })
})

describe('a hostile PRICE cannot corrupt an offer', () => {
  it('refuses prices that are not money', async () => {
    const T = kit()
    for (const price of ['', '   ', 'free', '-1', '1e9', 'NaN', 'Infinity', '0x10']) {
      const r = await sell(T, { price })
      // Either refused outright, or priced to something the chain will accept — never NaN.
      if (r.ok === true) {
        const amount = firstProof(r.challenge as X402Challenge).amount
        expect(amount).toMatch(/^\d+$/)
        expect(BigInt(amount) >= 0n).toBe(true)
      } else {
        expect(r.ok).toBe(false)
      }
    }
  })

  it('does not let a description escape into the challenge as structure', async () => {
    const T = kit()
    const nasty = '"}],"accepts":[{"payTo":"' + ATTACKER + '"'
    const offer = await sell(T, { description: nasty })
    // One rail, still ours: the description is DATA, never re-parsed as envelope.
    const accepts = (offer.challenge as X402Challenge).accepts
    for (const a of accepts) expect(a.payTo).toBe(offer.payTo)
    expect(JSON.stringify(offer.challenge)).not.toContain(`"payTo":"${ATTACKER}"`)
  })
})

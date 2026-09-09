/**
 * ── SELLING: the earning half of a sovereign wallet ──────────────────────────────────
 *
 * A wallet that can only spend is an allowance, however large the cap. These tests pin the
 * half that makes it the agent's own: price something, hand over a challenge, verify what
 * comes back, deliver only then.
 *
 * What matters most here, in order of the damage getting it wrong would do:
 *
 *   1. `collect` is the ONLY thing that proves payment. A buyer's claim, a well-formed
 *      proof and a settlement are three different things, and delivering on the first two
 *      is how an agent is robbed.
 *   2. One proof, one sale. A replay must never read as a second payment.
 *   3. `payTo` defaults to the agent's OWN address. An agent handed a key cannot look its
 *      address up anywhere else, and a wrong default here sends its income to a stranger.
 *   4. An offer that no agent-buyer can pay must SAY so, because the failure is silence:
 *      the money simply never arrives and nothing anywhere reports an error.
 */
import { describe, it, expect } from 'vitest'

// The fake driver has no exact SPI, so every offer legitimately prints the SDK's
// "no gasless rail here" hint. The TOOL RESULT is what these tests assert on, so quiet
// the stderr copy rather than reading past it in every run.
process.env.PIPRAIL_NO_HINTS = '1'
import { PipRailClient, paymentTools, type AgentTool } from '../src/index.js'
import { buildSignatureHeader } from '../src/x402.js'
import { firstProof } from './_dual-rail.js'
import { registerDriver } from '../src/drivers/index.js'
import type { PaymentDriver } from '../src/drivers/types.js'
import type { X402Challenge } from '../src/x402.js'

/** The address the agent's own key derives to — what `payTo` must default to. */
const MY_ADDRESS = '0xA6E17A6E17A6E17A6E17A6E17A6E17A6E17A6E17'
const SOMEONE_ELSE = '0xB0B0B0B0B0B0B0B0B0B0B0B0B0B0B0B0B0B0B0B0'
const CHAIN = { id: 8453, rpcUrl: 'https://fake.example/rpc' }

/** A fake EVM driver: no RPC, a wallet with a known address, and a verify that succeeds. */
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
      // Faithful to a real driver: an unknown symbol THROWS rather than resolving to something.
      // A fake that resolves anything would have hidden the "unknown, not zero" path entirely.
      resolveToken: (t) => {
        const sym = typeof t === 'string' ? t.toUpperCase() : 'USDC'
        if (sym !== 'USDC' && sym !== 'NATIVE') throw new Error(`unknown token ${sym}`)
        return sym === 'NATIVE'
          ? { asset: 'native', decimals: 18, symbol: 'ETH' }
          : { asset: '0xUSDC', decimals: 6, symbol: 'USDC' }
      },
      describeAsset: () => ({ symbol: 'USDC', decimals: 6 }),
      assertValidPayTo: () => undefined,
      bindWallet: (w) => ({ _native: w }),
      send: async () => `0x${'1'.repeat(64)}`,
      confirm: async () => ({ height: '1' }),
      estimateCost: async () => ({ feeSymbol: 'ETH', feeDecimals: 18, fee: '0', feeFormatted: '0', basis: 'heuristic' as const }),
      addressOf: async () => MY_ADDRESS,
      balanceOf: async () => ({ token: 0n, native: 0n }),
      recipientReady: async () => ({ ready: 'n/a' as const }),
      verify: async (ref, accept) => ({
        ok: true,
        receipt: {
          scheme: 'onchain-proof',
          success: true,
          network: accept.network,
          transaction: ref,
          asset: accept.asset,
          amount: accept.amount,
          payer: '0xpayer',
          payTo: accept.payTo,
          verifiedAt: 'now',
        },
      }),
    }
  },
}
registerDriver(fakeEvm)

type Res = Record<string, unknown>
const sovereign = () =>
  new PipRailClient({ chain: CHAIN, wallet: { key: '0xkey' }, mode: 'sovereign', swapPolicy: { maxPerSwap: '999' } } as never)
const kit = (c = sovereign()): Record<string, AgentTool> =>
  Object.fromEntries(paymentTools(c).map((t) => [t.name, t]))

/** Sell something and hand back both the tool result and a live toolkit sharing its offers. */
async function listOne(over: Res = {}) {
  const tools = kit()
  const sold = (await tools.piprail_sell!.invoke({
    description: 'Market analysis, 500 words',
    price: '2.50',
    ...over,
  })) as Res
  return { tools, sold }
}

/** A payment proof a buyer would hand back for the offer's challenge. */
function proofFor(challenge: X402Challenge, txHash = `0x${'a'.repeat(64)}`) {
  const accepted = firstProof(challenge)
  return {
    obj: { x402Version: 2 as const, accepted, payload: { nonce: accepted.extra!.nonce, txHash } },
    header: buildSignatureHeader({
      x402Version: 2,
      accepted,
      payload: { nonce: accepted.extra!.nonce, txHash },
    }),
  }
}

describe('an agent can put something up for sale', () => {
  it('prices it and returns a challenge to hand a buyer, with no server anywhere', async () => {
    const { sold } = await listOne()
    expect(sold.ok).toBe(true)
    expect(String(sold.offerId)).toMatch(/^offer_/)
    expect(sold.price).toBe('2.50')
    const challenge = sold.challenge as X402Challenge
    // The challenge is the whole product: it travels over any channel, needs no port.
    expect(challenge.x402Version).toBe(2)
    expect(firstProof(challenge).amount).toBe('2500000') // 2.50 at 6dp
  })

  it('returns the PAYMENT-REQUIRED header, so a self-served 402 is spec-conformant', async () => {
    // An agent serving its own offer over HTTP needs both halves of a 402: the body AND the
    // header. Without this it emitted a non-conformant challenge only a lenient buyer would pay.
    const { sold } = await listOne()
    expect(typeof sold.requiredHeader).toBe('string')
    expect(String(sold.requiredHeader).length).toBeGreaterThan(0)
    expect(String(sold.next)).toMatch(/requiredHeader/)
  })

  it('defaults payTo to the agent OWN address — the thing it cannot look up', async () => {
    const { sold } = await listOne()
    expect(sold.payTo).toBe(MY_ADDRESS)
    expect(sold.paidToYou).toBe(true)
    expect(firstProof(sold.challenge as X402Challenge).payTo).toBe(MY_ADDRESS)
  })

  it('still honours an explicit payTo, and says it is not the agent being paid', async () => {
    const { sold } = await listOne({ payTo: SOMEONE_ELSE })
    expect(sold.payTo).toBe(SOMEONE_ELSE)
    // Surfaced, not hidden: an agent should notice when its own sale pays somebody else.
    expect(sold.paidToYou).toBe(false)
  })

  it('refuses an offer with nothing to deliver or no price', async () => {
    const tools = kit()
    const noDesc = (await tools.piprail_sell!.invoke({ description: '  ', price: '1' })) as Res
    const noPrice = (await tools.piprail_sell!.invoke({ description: 'a thing', price: '' })) as Res
    expect(noDesc.ok).toBe(false)
    expect(noPrice.ok).toBe(false)
    expect(String(noPrice.reason)).toMatch(/price/i)
  })

  it('warns when the offer carries no exact rail, because the failure is SILENCE', async () => {
    /*
     * The fake driver has no exact SPI, so the rail drops. That is the dangerous case: the
     * gate works, the listing appears, and the ordinary x402 agent-buyer simply cannot pay
     * it. Nothing errors; the money just never comes. So it must be said out loud.
     */
    const { sold } = await listOne()
    expect(sold.schemes).toEqual(['onchain-proof'])
    const warnings = (sold.warnings ?? []) as string[]
    expect(warnings.join(' ')).toMatch(/cannot pay it/i)
  })
})

describe('collect is the only thing that proves payment', () => {
  it('verifies a real proof, reports what was earned, and clears delivery', async () => {
    const { tools, sold } = await listOne()
    const got = (await tools.piprail_collect!.invoke({
      offerId: sold.offerId,
      payment: proofFor(sold.challenge as X402Challenge).header,
    })) as Res
    expect(got.paid).toBe(true)
    expect(got.earned).toBe('2.50 USDC')
    expect(String(got.next)).toMatch(/Deliver/i)
  })

  it('accepts the decoded JSON payload too — an agent relaying it cannot know which it holds', async () => {
    const { tools, sold } = await listOne()
    const got = (await tools.piprail_collect!.invoke({
      offerId: sold.offerId,
      payment: JSON.stringify(proofFor(sold.challenge as X402Challenge).obj),
    })) as Res
    expect(got.paid).toBe(true)
  })

  it('REFUSES a replay: one proof is one sale, never two', async () => {
    const { tools, sold } = await listOne()
    const { header } = proofFor(sold.challenge as X402Challenge)
    const first = (await tools.piprail_collect!.invoke({ offerId: sold.offerId, payment: header })) as Res
    const second = (await tools.piprail_collect!.invoke({ offerId: sold.offerId, payment: header })) as Res
    expect(first.paid).toBe(true)
    expect(second.paid).toBe(false)
    expect(String(second.reason)).toMatch(/used|replay|already/i)
    expect(String(second.next)).toMatch(/do NOT deliver/i)
  })

  it('never reads a missing or malformed payment as paid', async () => {
    const { tools, sold } = await listOne()
    for (const payment of ['', 'garbage-not-base64', '{"half":']) {
      const got = (await tools.piprail_collect!.invoke({ offerId: sold.offerId, payment })) as Res
      expect(got.paid).not.toBe(true)
    }
  })

  it('explains an unknown offer instead of failing blankly', async () => {
    const { tools } = await listOne()
    const got = (await tools.piprail_collect!.invoke({ offerId: 'offer_nope', payment: 'x' })) as Res
    expect(got.ok).toBe(false)
    expect(String(got.reason)).toMatch(/no offer/i)
    expect(Array.isArray(got.offers)).toBe(true)
  })
})

describe('piprail_wallet — the balance sheet, not the leash', () => {
  /*
   * A sovereign agent had thirteen tools and could not answer "what do I have?". `piprail_budget`
   * reports how much of an ALLOWANCE is left, which is a different question, and
   * `piprail_plan_payment` only answers it for one URL at a time. An agent that owns its finances
   * has to see its own balance sheet before it can decide to sell, to swap, or to ask for a top-up.
   */
  it('reports the agent OWN address, which it can hand to anyone paying it', async () => {
    const got = (await kit().piprail_wallet!.invoke({})) as Res
    expect(got.ok).toBe(true)
    expect(got.address).toBe(MY_ADDRESS)
    expect(String(got.next)).toMatch(/address/i)
  })

  it('separates the spend leash from what is actually held', async () => {
    const tools = kit()
    const wallet = (await tools.piprail_wallet!.invoke({})) as Res
    const budget = (await tools.piprail_budget!.invoke({})) as Res
    // Two different questions, two different answers: neither may stand in for the other.
    expect(wallet).toHaveProperty('holdings')
    expect(budget).not.toHaveProperty('holdings')
    expect(wallet).not.toHaveProperty('remaining')
  })

  it('reports an UNREADABLE balance as unknown, never as zero', async () => {
    /*
     * The single most dangerous rounding in the whole tool. A rate-limited read that came back
     * as `0` would tell an agent it had been drained, and a sovereign agent acting on that would
     * fire-sale whatever it could to recover from a loss that never happened.
     */
    const got = (await kit().piprail_wallet!.invoke({})) as Res
    const holdings = got.holdings as Array<Record<string, unknown>>
    for (const h of holdings) {
      if (h.amount === null) expect(h.amountFormatted).toBeNull()
      expect(h.amount).not.toBe(0) // never a NUMBER zero standing in for "unknown"
    }
    expect(String(got.report)).toBeTruthy()
  })

  it('says a symbol is UNKNOWN rather than guessing a zero for it', async () => {
    const got = (await kit().piprail_wallet!.invoke({ assets: ['NOT_A_REAL_TOKEN'] })) as Res
    const [row] = got.holdings as Array<Record<string, unknown>>
    expect(row!.known).toBe(false)
    expect(row!.amount).toBeNull()
  })

  it('is read-only and needs no approval', () => {
    const t = kit().piprail_wallet!
    expect(t.annotations?.readOnlyHint).toBe(true)
    expect(t.annotations?.destructiveHint).toBeUndefined()
  })

  it('is withheld from the restricted modes with every other sovereign tool', () => {
    const budgeted = new PipRailClient({ chain: CHAIN, wallet: { key: '0xkey' } } as never)
    expect(paymentTools(budgeted).map((t) => t.name)).not.toContain('piprail_wallet')
  })
})

describe('earnings counts what was PROVEN, not what was claimed', () => {
  it('stays empty until a payment actually verifies', async () => {
    const { tools, sold } = await listOne()
    const before = (await tools.piprail_earnings!.invoke({})) as Res
    expect(before.collected).toBe(0)
    expect(String(before.report)).toMatch(/nothing paid yet/i)

    await tools.piprail_collect!.invoke({
      offerId: sold.offerId,
      payment: proofFor(sold.challenge as X402Challenge).header,
    })
    const after = (await tools.piprail_earnings!.invoke({})) as Res
    expect(after.collected).toBe(1)
    expect(after.totals).toEqual({ USDC: '2.5' })
  })

  it('a failed collect adds nothing', async () => {
    const { tools, sold } = await listOne()
    await tools.piprail_collect!.invoke({ offerId: sold.offerId, payment: 'garbage' })
    expect(((await tools.piprail_earnings!.invoke({})) as Res).collected).toBe(0)
  })
})

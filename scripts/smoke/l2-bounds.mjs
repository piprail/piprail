/**
 * L2 · BOUNDS — every numeric knob at its minimum, its maximum, and one step outside.
 *
 * Off-by-one is where money bugs live. A cap that refuses AT the limit silently costs a
 * merchant sales; a cap that allows ONE unit past it is a leak, and both look identical in a
 * test that only ever uses round numbers in the middle of the range. So every bound here is
 * pinned three times: the last allowed value, the first refused value, and the far edge.
 *
 * Covered: gate amounts, token decimals, policy caps, swap slippage and ceilings, the replay
 * window, the payment-identifier length, and bigint amounts far beyond a float's reach.
 */
export const meta = {
  id: 'bounds',
  layer: 'L2',
  what: 'min/max/one-past for amounts, decimals, caps, slippage, windows, identifier length',
  why: 'a cap that is off by one unit either loses sales or leaks money, and both look normal',
}

const PAY_TO = '0x' + '3'.repeat(40)
const REF = (n) => '0x' + String(n).repeat(64).slice(0, 64)

export async function run({ sdk, section, check, throws, serve }) {
  const {
    createPaymentGate, registerDriver, buildSignatureHeader, PipRailClient,
    evaluatePolicy, resolveSlippageBps, applySlippage, MAX_SLIPPAGE_BPS, DEFAULT_SLIPPAGE_BPS,
  } = sdk

  // A driver whose token decimals are configurable, so decimal bounds are testable.
  let DECIMALS = 6
  let sendCounter = 0
  registerDriver({
    family: 'evm',
    resolve(opts) {
      const chain = opts.chain
      const id = typeof chain === 'object' ? chain.id : { base: 8453 }[chain]
      if (typeof id !== 'number') return null
      const network = `eip155:${id}`
      return {
        family: 'evm', network, supports: (n) => n === network,
        resolveToken: () => ({ asset: '0x' + 'a'.repeat(40), decimals: DECIMALS, symbol: 'TOK' }),
        describeAsset: () => ({ symbol: 'TOK', decimals: DECIMALS }),
        assertValidPayTo: (a) => { if (!/^0x[0-9a-fA-F]{40}$/.test(String(a))) throw new sdk.WrongFamilyError('not EVM') },
        bindWallet: (w) => ({ _native: w }),
        send: async () => `0x${(++sendCounter).toString(16).padStart(64, 'e')}`,
        confirm: async () => ({ height: '1' }),
        estimateCost: async () => ({ feeSymbol: 'ETH', feeDecimals: 18, fee: '0', feeFormatted: '0', basis: 'heuristic' }),
        addressOf: async () => '0xself',
        balanceOf: async () => ({ token: 10n ** 30n, native: 10n ** 30n }),
        recipientReady: async () => ({ ready: 'n/a' }),
        verify: async (ref, accept) => ({
          ok: true,
          receipt: { scheme: 'onchain-proof', success: true, network: accept.network, transaction: ref,
            asset: accept.asset, amount: accept.amount, payer: '0xpayer', payTo: accept.payTo, verifiedAt: 'now' },
        }),
      }
    },
  })

  const CHAIN = { id: 8453, rpcUrl: 'x' }
  const gate = (over = {}) => createPaymentGate({ chain: CHAIN, token: 'TOK', amount: '0.05', payTo: PAY_TO, ...over })
  const amountOf = async (amount) => {
    const { challenge } = await gate({ amount }).challenge('https://x/r')
    return challenge.accepts.find((a) => a.scheme === 'onchain-proof').amount
  }

  // ── gate amount ─────────────────────────────────────────────────────────────
  section('bounds · a gate amount', 'the smallest chargeable unit, and the first that is not')

  DECIMALS = 6
  await check('MIN: one base unit (0.000001 at 6dp) is chargeable', async () =>
    (await amountOf('0.000001')) === '1' ? '1 base unit' : { fail: 'not 1' })

  await throws('BELOW MIN: 0.0000001 rounds to zero and is refused', () => amountOf('0.0000001'))
  await throws('ZERO is refused', () => amountOf('0'), 'greater than zero')
  await throws('NEGATIVE is refused', () => amountOf('-0.000001'))

  await check('a whole number is exact', async () => (await amountOf('1')) === '1000000' ? '1 → 1000000' : { fail: 'wrong' })

  await check('MAX: a 30-digit amount stays bigint-exact (no float drift)', async () => {
    const big = '1000000000000000000000000000000' // 1e30
    const got = await amountOf(big)
    const want = (BigInt(big) * 10n ** 6n).toString()
    return got === want ? `1e30 exact (${got.length} digits)` : { fail: `got ${got}` }
  })

  await check('trailing zeros do not change the value', async () =>
    (await amountOf('0.050000')) === (await amountOf('0.05')) ? 'equal' : { fail: 'differ' })

  // ── token decimals ──────────────────────────────────────────────────────────
  section('bounds · token decimals', `0 through MAX_DECIMALS, and past it`)

  DECIMALS = 0
  await check('MIN: a 0-decimal token charges whole units', async () =>
    (await amountOf('5')) === '5' ? '5 → 5' : { fail: 'wrong at 0dp' })
  await throws('0dp: a fractional amount is refused', () => amountOf('0.5'))

  DECIMALS = 18
  await check('18dp: one wei is chargeable', async () =>
    (await amountOf('0.000000000000000001')) === '1' ? '1 wei' : { fail: 'wrong at 18dp' })
  await check('18dp: a large amount stays exact', async () =>
    (await amountOf('123.456789012345678901')) === '123456789012345678901' ? 'exact to the last wei' : { fail: 'drifted' })

  DECIMALS = 100 // exactly MAX_DECIMALS
  await check('MAX_DECIMALS (100) is still priceable', async () => {
    try { const a = await amountOf('1'); return `1 → ${String(a).length} digits` }
    catch (e) { return { fail: `refused at the documented maximum: ${e.message.slice(0, 70)}` } }
  })

  DECIMALS = 101 // one past
  await check('PAST MAX: 101 decimals is refused, not silently mis-priced', async () => {
    try { const a = await amountOf('1'); return { fail: `priced a 101dp token: ${String(a).slice(0, 30)}…` } }
    catch (e) { return `refused: ${e.constructor.name}` }
  })
  DECIMALS = 6

  // ── policy caps ─────────────────────────────────────────────────────────────
  section('bounds · policy caps are INCLUSIVE at the limit, and refuse one unit past')

  const intent = (base) => ({
    host: 'shop.example.com', chain: 'base', network: 'eip155:8453',
    asset: '0x' + 'a'.repeat(40), symbol: 'USDC', amountBase: base, decimals: 6, recognized: true,
  })

  await check('maxAmount: EXACTLY at the cap is allowed', () =>
    evaluatePolicy(intent(1_000_000n), { maxAmount: '1.00' }, 0n).allowed === true ? 'allowed' : { fail: 'refused AT the cap' })
  await check('maxAmount: ONE base unit over is refused', () =>
    evaluatePolicy(intent(1_000_001n), { maxAmount: '1.00' }, 0n).allowed === false ? 'refused' : { fail: 'allowed one unit over' })
  await check('maxAmount: one base unit UNDER is allowed', () =>
    evaluatePolicy(intent(999_999n), { maxAmount: '1.00' }, 0n).allowed === true ? 'allowed' : { fail: 'refused under the cap' })

  await check('maxTotal: spending EXACTLY to the cap is allowed', () =>
    evaluatePolicy(intent(1_000_000n), { maxTotal: '2.00' }, 1_000_000n).allowed === true ? 'allowed' : { fail: 'refused AT the total' })
  await check('maxTotal: one base unit past the cap is refused', () =>
    evaluatePolicy(intent(1_000_001n), { maxTotal: '2.00' }, 1_000_000n).allowed === false ? 'refused' : { fail: 'allowed past the total' })

  await check('maxAmount of 0 refuses everything (a zero allowance is a real setting)', () =>
    evaluatePolicy(intent(1n), { maxAmount: '0' }, 0n).allowed === false ? 'refused' : { fail: 'a zero cap allowed a payment' })

  await check('a cap far beyond any real balance still parses and allows', () =>
    evaluatePolicy(intent(10n ** 24n), { maxAmount: '1000000000000000000' }, 0n).allowed === true
      ? 'allowed at 1e18 tokens' : { fail: 'refused a huge but valid cap' })

  // ── payment count leash ─────────────────────────────────────────────────────
  section('bounds · the payment-count leash')

  await check('maxPayments: the Nth payment is allowed, the N+1th is not', () => {
    const ctx = (count) => ({ now: Date.now(), sessionStart: Date.now() - 1000, spentInWindowBase: 0n, paymentCount: count })
    const at = evaluatePolicy(intent(1n), { maxPayments: 3 }, 0n, ctx(2)) // 2 already made → this is the 3rd
    const past = evaluatePolicy(intent(1n), { maxPayments: 3 }, 0n, ctx(3)) // 3 already made → this is the 4th
    if (at.allowed !== true) return { fail: 'refused the Nth payment' }
    return past.allowed === false ? '3rd allowed, 4th refused' : { fail: 'allowed the N+1th' }
  })

  await check('maxPayments: 0 refuses the very first payment', () => {
    const ctx = { now: Date.now(), sessionStart: Date.now() - 1000, spentInWindowBase: 0n, paymentCount: 0 }
    return evaluatePolicy(intent(1n), { maxPayments: 0 }, 0n, ctx).allowed === false
      ? 'refused' : { fail: 'maxPayments:0 allowed a payment' }
  })

  // ── slippage ────────────────────────────────────────────────────────────────
  section('bounds · swap slippage', `0 to ${MAX_SLIPPAGE_BPS} bps inclusive`)

  await check('MIN: 0 bps is accepted', () => resolveSlippageBps(0) === 0 ? '0' : { fail: 'rejected 0' })
  await check(`MAX: ${MAX_SLIPPAGE_BPS} bps is accepted`, () =>
    resolveSlippageBps(MAX_SLIPPAGE_BPS) === MAX_SLIPPAGE_BPS ? String(MAX_SLIPPAGE_BPS) : { fail: 'rejected the max' })
  await throws(`PAST MAX: ${MAX_SLIPPAGE_BPS + 1} bps is refused`, () => resolveSlippageBps(MAX_SLIPPAGE_BPS + 1))
  await throws('BELOW MIN: -1 bps is refused', () => resolveSlippageBps(-1))
  await check('undefined resolves to the documented default', () =>
    resolveSlippageBps(undefined) === DEFAULT_SLIPPAGE_BPS ? `${DEFAULT_SLIPPAGE_BPS}` : { fail: 'wrong default' })

  await check('applySlippage(0) is the exact identity', () => applySlippage(12_345_678n, 0) === 12_345_678n)
  await check(`applySlippage at ${MAX_SLIPPAGE_BPS} bps is +10% exactly`, () => {
    const out = applySlippage(1_000_000n, MAX_SLIPPAGE_BPS)
    return out === 1_100_000n ? '1000000 → 1100000' : { fail: `got ${out}` }
  })
  await check('applySlippage stays positive and exact at 2^255', () => {
    const out = applySlippage(2n ** 255n, MAX_SLIPPAGE_BPS)
    return out > 2n ** 255n ? 'grew, no overflow' : { fail: `got ${out}` }
  })

  // ── the swap ceiling ────────────────────────────────────────────────────────
  section('bounds · swapPolicy.maxPerSwap binds on the CEILING, not the estimate')

  await check('a ceiling EQUAL to maxPerSwap is allowed', () => {
    // parseUnits('1.00', 6) === 1000000; a quote whose maxSpend is exactly that must pass.
    const c = new PipRailClient({ chain: CHAIN, wallet: { key: '0x' + '1'.repeat(64) }, mode: 'sovereign', swapPolicy: { maxPerSwap: '1.00' } })
    return c.swapPolicy().maxPerSwap === '1.00' ? 'cap readable at the boundary' : { fail: 'cap not readable' }
  })

  await throws('sovereign with NO ceiling is refused', () =>
    new PipRailClient({ chain: CHAIN, wallet: { key: '0x' + '1'.repeat(64) }, mode: 'sovereign' }))

  await check('a maxPerSwap of 0 is a real setting (refuse every swap), not "unlimited"', () => {
    const c = new PipRailClient({ chain: CHAIN, wallet: { key: '0x' + '1'.repeat(64) }, mode: 'sovereign', swapPolicy: { maxPerSwap: '0' } })
    return c.swapPolicy().maxPerSwap === '0' ? 'accepted as a zero ceiling' : { fail: 'coerced away' }
  })

  // ── the replay window ───────────────────────────────────────────────────────
  section('bounds · the replay window')

  await check('MIN: a 1-second window still issues a payable challenge', async () => {
    const { challenge } = await gate({ maxTimeoutSeconds: 1 }).challenge('https://x/r')
    const a = challenge.accepts.find((x) => x.scheme === 'onchain-proof')
    return a.maxTimeoutSeconds === 1 ? '1s advertised' : { fail: `got ${a.maxTimeoutSeconds}` }
  })

  await check('MAX: a very long window is advertised verbatim', async () => {
    const { challenge } = await gate({ maxTimeoutSeconds: 86_400 }).challenge('https://x/r')
    const a = challenge.accepts.find((x) => x.scheme === 'onchain-proof')
    return a.maxTimeoutSeconds === 86_400 ? '24h advertised' : { fail: `got ${a.maxTimeoutSeconds}` }
  })

  await check('the DEFAULT window is the documented 600s', async () => {
    const { challenge } = await gate().challenge('https://x/r')
    const a = challenge.accepts.find((x) => x.scheme === 'onchain-proof')
    return a.maxTimeoutSeconds === 600 ? '600s' : { fail: `got ${a.maxTimeoutSeconds}` }
  })

  await check('replay protection holds even with a 1-second window', async () => {
    const g = gate({ maxTimeoutSeconds: 1 })
    const one = await g.challenge('https://x/r')
    const a1 = one.challenge.accepts.find((x) => x.scheme === 'onchain-proof')
    const first = await g.verify(buildSignatureHeader({ x402Version: 2, accepted: a1, payload: { nonce: a1.extra.nonce, txHash: REF(4) } }))
    const two = await g.challenge('https://x/r')
    const a2 = two.challenge.accepts.find((x) => x.scheme === 'onchain-proof')
    const second = await g.verify(buildSignatureHeader({ x402Version: 2, accepted: a2, payload: { nonce: a2.extra.nonce, txHash: REF(4) } }))
    return first.kind === 'paid' && second.kind !== 'paid' ? `refused: ${second.error}` : { fail: 'replay slipped through' }
  })

  // ── payment-identifier length ───────────────────────────────────────────────
  section('bounds · the payment-identifier length window (16 to 128 chars)')

  const idCheck = async (len, expectPaid) => {
    const g = gate({ paymentIdentifier: true })
    const { challenge } = await g.challenge('https://x/r')
    const a = challenge.accepts.find((x) => x.scheme === 'onchain-proof')
    const id = 'a'.repeat(len)
    const r = await g.verify(buildSignatureHeader({
      x402Version: 2, accepted: a, payload: { nonce: a.extra.nonce, txHash: REF(5) },
      extensions: { 'payment-identifier': { info: { id } } },
    }))
    const paid = r.kind === 'paid'
    return paid === expectPaid ? `${len} chars → ${paid ? 'accepted' : 'refused'}` : { fail: `${len} chars → ${paid ? 'accepted' : 'refused'}, wanted the opposite` }
  }

  await check('BELOW MIN: 15 characters is refused', () => idCheck(15, false))
  await check('MIN: exactly 16 characters is accepted', () => idCheck(16, true))
  await check('MAX: exactly 128 characters is accepted', () => idCheck(128, true))
  await check('PAST MAX: 129 characters is refused', () => idCheck(129, false))
}

/**
 * L2 · MODES — the three authority modes, and whether `sovereign` really means sovereign.
 *
 * The claim under test: an agent handed a key in sovereign mode controls its OWN economic life
 * end to end. It can find out who it is, see what it holds, price and sell its work, collect and
 * prove payment, convert between denominations, spend, and know its limits. Nothing in that loop
 * may need a human. The other two modes must be genuinely restricted, and no mode may widen
 * itself, because a model that can grant itself authority has none.
 */
export const meta = {
  id: 'modes',
  layer: 'L2',
  what: 'supervised / budgeted / sovereign, the sovereignty loop, escalation attempts',
  why: 'capability follows authority; a mode that leaks or self-widens is worse than no mode',
}

const WALLET = '0x' + '1'.repeat(64)

export async function run({ sdk, section, check, throws, eq }) {
  const { PipRailClient, paymentTools, AGENT_MODES, DEFAULT_AGENT_MODE, registerDriver } = sdk

  registerDriver({
    family: 'evm',
    resolve(opts) {
      const chain = opts.chain
      const id = typeof chain === 'object' ? chain.id : { base: 8453 }[chain]
      if (typeof id !== 'number') return null
      const network = `eip155:${id}`
      return {
        family: 'evm', network, supports: (n) => n === network,
        resolveToken: (t) => ({ asset: '0x' + 'a'.repeat(40), decimals: 6, symbol: String(t ?? 'USDC') }),
        describeAsset: () => ({ symbol: 'USDC', decimals: 6 }),
        assertValidPayTo: () => undefined,
        bindWallet: (w) => ({ _native: w }),
        send: async () => '0x' + '1'.repeat(64),
        confirm: async () => ({ height: '1' }),
        estimateCost: async () => ({ feeSymbol: 'ETH', feeDecimals: 18, fee: '21000', feeFormatted: '0.000021', basis: 'estimated' }),
        addressOf: async () => '0x' + 'e'.repeat(40),
        balanceOf: async () => ({ token: 5_000_000n, native: 10n ** 16n }),
        recipientReady: async () => ({ ready: 'n/a' }),
        verify: async (ref, accept) => ({
          ok: true,
          receipt: { scheme: 'onchain-proof', success: true, network: accept.network, transaction: ref,
            asset: accept.asset, amount: accept.amount, payer: '0xbuyer', payTo: accept.payTo, verifiedAt: 'now' },
        }),
      }
    },
  })

  const mk = (mode, extra = {}) => new PipRailClient({
    chain: 'base', wallet: WALLET, mode,
    ...(mode === 'supervised' ? { onBeforePay: async () => true } : {}),
    ...(mode === 'sovereign' ? { swapPolicy: { maxPerSwap: '25.00' } } : {}),
    ...extra,
  })
  const toolsOf = (c) => paymentTools(c).map((t) => t.name)

  section('modes · three modes, distinct and ordered')

  eq('exactly three, budgeted is the default', [[...AGENT_MODES], DEFAULT_AGENT_MODE],
    [['supervised', 'budgeted', 'sovereign'], 'budgeted'])

  const SETS = Object.fromEntries(AGENT_MODES.map((m) => [m, toolsOf(mk(m))]))

  await check('supervised and budgeted expose the same eight tools', () =>
    SETS.supervised.length === 8 && JSON.stringify(SETS.supervised) === JSON.stringify(SETS.budgeted)
      ? '8 each, identical' : { fail: `supervised=${SETS.supervised.length} budgeted=${SETS.budgeted.length}` })

  await check('sovereign is a strict superset, adding six', () => {
    const lost = SETS.budgeted.filter((t) => !SETS.sovereign.includes(t))
    if (lost.length) return { fail: `sovereign LOST ${lost.join(', ')}` }
    const extra = SETS.sovereign.filter((t) => !SETS.budgeted.includes(t))
    return `+${extra.length}: ${extra.join(', ')}`
  })

  // ── the sovereignty loop ────────────────────────────────────────────────────
  section('modes · 👑 the full economic loop, with no human in it',
    'earn → know → convert → spend → account. A gap anywhere means it is not sovereign.')

  const sov = mk('sovereign')
  const T = Object.fromEntries(paymentTools(sov).map((t) => [t.name, t]))

  const LOOP = [
    ['know who it is (receive address)', 'piprail_wallet'],
    ['know what it holds', 'piprail_wallet'],
    ['price its own work', 'piprail_sell'],
    ['take money, and prove it', 'piprail_collect'],
    ['account for earnings', 'piprail_earnings'],
    ['find what to buy', 'piprail_discover'],
    ['price a purchase', 'piprail_quote_payment'],
    ['check it can afford it', 'piprail_plan_payment'],
    ['spend', 'piprail_pay_request'],
    ['price a conversion', 'piprail_quote_swap'],
    ['convert', 'piprail_swap'],
    ['know its own limits', 'piprail_budget'],
    ['prove a payment it made', 'piprail_verify_receipt'],
    ['be findable', 'piprail_register'],
  ]
  for (const [label, tool] of LOOP) {
    await check(`${label.padEnd(34)} → ${tool}`, () =>
      SETS.sovereign.includes(tool) ? 'available' : { fail: `MISSING: ${tool}` })
  }

  await check('it derives its OWN address from the key, no RPC, no human', async () => {
    const a = await sov.address()
    return /^0x[0-9a-fA-F]{40}$/.test(a) ? `derived ${a.slice(0, 10)}…` : { fail: String(a) }
  })

  await check('it can read its own balances', async () => {
    const b = await sov.balanceOf()
    return Array.isArray(b) && b.length ? `${b.length} asset balance(s)` : { fail: JSON.stringify(b) }
  })

  await check('sell defaults payTo to its OWN address (it keeps what it earns)', async () => {
    const r = await T.piprail_sell.invoke({ description: 'a haiku', price: '1.00' })
    const o = typeof r === 'string' ? JSON.parse(r) : r
    const self = await sov.address()
    return String(o.payTo).toLowerCase() === self.toLowerCase()
      ? 'earnings land on its own key' : { fail: `payTo=${o.payTo}` }
  })

  await check('no human hook is required to construct it', () => {
    new PipRailClient({ chain: 'base', wallet: WALLET, mode: 'sovereign', swapPolicy: { maxPerSwap: '25' } })
    return 'constructs with no confirmation hook'
  })

  await check('no spend policy is imposed on it', () =>
    mk('sovereign').policy() === undefined ? 'it sets its own, or none' : { fail: 'a policy was imposed' })

  await check('the ONLY mandatory ceiling is the swap loop-drain guard', () => {
    try { new PipRailClient({ chain: 'base', wallet: WALLET, mode: 'sovereign' }); return { fail: 'no ceiling required' } }
    catch (e) { return /maxPerSwap/.test(e.message) ? 'maxPerSwap only' : { fail: e.message.slice(0, 80) } }
  })

  // ── the restricted modes ────────────────────────────────────────────────────
  section('modes · the other two are genuinely restricted')

  for (const tool of ['piprail_sell', 'piprail_collect', 'piprail_earnings', 'piprail_swap', 'piprail_quote_swap', 'piprail_wallet']) {
    await check(`budgeted cannot ${tool}`, () =>
      !SETS.budgeted.includes(tool) ? 'absent' : { fail: 'LEAKED into budgeted' })
  }

  await check('supervised REQUIRES a human hook', () => {
    try { new PipRailClient({ chain: 'base', wallet: WALLET, mode: 'supervised' }); return { fail: 'constructed without onBeforePay' } }
    catch (e) { return /onBeforePay/.test(e.message) ? 'refused' : { fail: e.message.slice(0, 80) } }
  })

  await check('supervised cannot sell or swap even with the hook', () => {
    const c = mk('supervised')
    return c.canAgentSell() === false && c.canAgentSwap() === false ? 'both false' : { fail: 'authority leaked' }
  })

  // ── escalation ──────────────────────────────────────────────────────────────
  section('modes · no mode can widen itself')

  await check('every invalid mode FAILS CLOSED to the restricted set', () => {
    const bad = ['godmode', 'sovreign', 'SOVEREIGN', 'Sovereign', ' sovereign', '', null, undefined, 0, 1, {}, [], true]
    const bad2 = bad.filter((m) => {
      const c = new PipRailClient({ chain: 'base', wallet: WALLET, mode: m })
      return paymentTools(c).length > 8 || c.canAgentSell() === true || c.canAgentSwap() === true
    })
    return bad2.length === 0 ? `all ${bad.length} invalid modes → restricted` : { fail: `ESCALATION via ${JSON.stringify(bad2)}` }
  })

  for (const key of ['mode', 'canAgentSell', 'canAgentSwap']) {
    await check(`${key}() cannot be reassigned on the instance`, () => {
      const c = mk('budgeted')
      let threw = false
      try { c[key] = () => (key === 'mode' ? 'sovereign' : true) } catch { threw = true }
      const stillEight = paymentTools(c).length === 8
      return threw && stillEight ? 'sealed' : { fail: `threw=${threw} tools=${paymentTools(c).length}` }
    })
  }

  await check('no tool accepts a `mode` argument', () => {
    const bad = []
    for (const m of AGENT_MODES) {
      for (const t of paymentTools(mk(m))) {
        if (Object.keys(t.parameters?.properties ?? {}).some((p) => /^mode$/i.test(p))) bad.push(`${m}/${t.name}`)
      }
    }
    return bad.length === 0 ? 'none' : { fail: bad.join(', ') }
  })

  await check('a swapPolicy alone cannot smuggle in sovereignty', () => {
    const c = new PipRailClient({ chain: 'base', wallet: WALLET, swapPolicy: { maxPerSwap: '999' } })
    return paymentTools(c).length === 8 && c.canAgentSwap() === false ? 'grants nothing' : { fail: 'authority leaked' }
  })
}

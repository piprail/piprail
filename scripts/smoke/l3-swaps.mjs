/**
 * L3 · SWAPS — does every network we advertise as swappable actually route?
 *
 * `canSwapOn(network) === true` is a promise to an agent: name this chain and a swap will
 * route. The registry cannot keep that promise on its own; the provider has to answer, on that
 * chain, for a real pair. This asks each one for a live quote.
 *
 * Read-only: a quote moves nothing. Execution belongs to L4.
 *
 * 🔴 The stablecoin a chain ships is NOT always USDC. Robinhood is USDG-only, and TON and Tron
 * carry USD₮ because Circle issues no native USDC on either. Asking for USDC there tests
 * nothing and reports a false "no route" — a mistake worth encoding once, here.
 */
export const meta = {
  id: 'swaps',
  layer: 'L3',
  what: 'a live quote on every swappable network, plus the guardrails that bound one',
  why: 'advertising a swap that cannot route is a promise the SDK breaks at the worst moment',
  network: true,
  wallets: true,
}

const STABLE = { robinhood: 'USDG', ton: 'USDT', tron: 'USDT' }

export async function run({ sdk, section, check, wallet, REPO }) {
  const { swappableNetworks, swapProvidersFor, PipRailClient, canSwapOn, resolveSlippageBps, MAX_SLIPPAGE_BPS } = sdk

  const evm = wallet('evm', REPO)
  const evmKey = { key: evm.privateKey }
  const CHAIN_FOR = {
    'eip155:1': ['ethereum', evmKey],
    'eip155:10': ['optimism', evmKey],
    'eip155:56': ['bnb', evmKey],
    'eip155:130': ['unichain', evmKey],
    'eip155:137': ['polygon', evmKey],
    'eip155:143': ['monad', evmKey],
    'eip155:999': ['hyperevm', evmKey],
    'eip155:1329': ['sei', evmKey],
    'eip155:4663': ['robinhood', evmKey],
    'eip155:8453': ['base', evmKey],
    'eip155:42161': ['arbitrum', evmKey],
    'eip155:43114': ['avalanche', evmKey],
    'eip155:59144': ['linea', evmKey],
    'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp': ['solana', { key: wallet('solana', REPO).secretKey }],
    'near:mainnet': (() => { const w = wallet('near', REPO); return ['near', { accountId: w.accountId, key: w.privateKey }] })(),
    'sui:mainnet': ['sui', { key: wallet('sui', REPO).privateKey }],
    'aptos:1': ['aptos', { key: wallet('aptos', REPO).privateKey }],
    'stellar:pubnet': ['stellar', { key: wallet('stellar', REPO).secret }],
    'tron:mainnet': ['tron', { key: wallet('tron', REPO).privateKey }],
    'tvm:-239': ['ton', { key: wallet('ton', REPO).mnemonic }],
    'xrpl:0': ['xrpl', { key: wallet('xrpl', REPO).seed }],
    'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=': ['algorand', { key: wallet('algorand', REPO).mnemonic }],
  }

  const nets = swappableNetworks()
  section('swaps · every advertised network routes live', `${nets.length} networks`)

  for (const net of nets) {
    const mapped = CHAIN_FOR[net]
    if (!mapped) {
      await check(`${net}`, () => ({ fail: 'advertised swappable but this harness has no chain mapping — add it' }))
      continue
    }
    const [chain, key] = mapped
    const providers = swapProvidersFor(net).map((p) => p.name).join(', ')
    await check(`${chain.padEnd(10)} ${net}`, async () => {
      const c = new PipRailClient({ chain, wallet: key, mode: 'sovereign', swapPolicy: { maxPerSwap: '1000' } })
      const stable = STABLE[chain] ?? 'USDC'
      const q = await c.quoteSwap({ from: stable, to: 'native', wantAmount: '0.001' })
      if (q) return `${q.source?.name}: ${q.from?.amountFormatted} ${q.from?.symbol} → ${q.to?.amountFormatted} ${q.to?.symbol}`
      // Some venues price one direction only; try the reverse before calling it dead.
      const q2 = await c.quoteSwap({ from: 'native', to: stable, wantAmount: '0.01' })
      return q2 ? `${q2.source?.name} (native→${stable})` : { fail: `no route either way for ${stable}/native (${providers})` }
    })
  }

  section('swaps · the guardrails that bound one', 'a swap moves the agent\'s OWN funds, so payment caps never see it')

  await check('canSwapOn agrees with swappableNetworks', () => {
    const bad = nets.filter((n) => !canSwapOn(n))
    return bad.length === 0 ? `${nets.length} consistent` : { fail: bad.join(', ') }
  })
  await check('canSwapOn is false for an unknown network', () =>
    canSwapOn('eip155:999999') === false && canSwapOn('nonsense') === false ? 'no accidental yes' : { fail: 'said yes' })

  await check('a tolerance above the hard maximum is REFUSED, not clamped', () => {
    try { resolveSlippageBps(MAX_SLIPPAGE_BPS + 1); return { fail: 'allowed' } }
    catch { return `capped at ${MAX_SLIPPAGE_BPS} bps` }
  })

  // The live guardrail checks need one chain with a real route; Solana is the cheapest read.
  const sol = new PipRailClient({
    chain: 'solana', wallet: { key: wallet('solana', REPO).secretKey },
    mode: 'sovereign', swapPolicy: { maxPerSwap: '5.00' },
  })
  const REQ = { from: 'USDC', to: 'native', wantAmount: '0.0005' }
  const quote = await sol.quoteSwap(REQ)

  await check('a quote reports an on-chain ceiling at or above its estimate', () =>
    quote && BigInt(quote.maxSpend) >= BigInt(quote.from.amount)
      ? `ceiling ${quote.maxSpendFormatted} ≥ estimate ${quote.from.amountFormatted}`
      : { fail: 'the cap would bind the wrong number' })

  await check('maxPerSwap below the ceiling DECLINES before signing', async () => {
    if (!quote) return { fail: 'no quote to test against' }
    const tight = new PipRailClient({
      chain: 'solana', wallet: { key: wallet('solana', REPO).secretKey },
      mode: 'sovereign', swapPolicy: { maxPerSwap: '0.01' },
    })
    try { await tight.swap(quote); return { fail: 'SWAPPED past the cap' } }
    catch (e) { return e.constructor.name === 'PaymentDeclinedError' ? 'declined, nothing signed' : { fail: `threw ${e.constructor.name}` } }
  })

  await check('a slippage request above swapPolicy.maxSlippageBps is refused', async () => {
    const strict = new PipRailClient({
      chain: 'solana', wallet: { key: wallet('solana', REPO).secretKey },
      mode: 'sovereign', swapPolicy: { maxPerSwap: '5.00', maxSlippageBps: 10 },
    })
    try { await strict.quoteSwap({ ...REQ, slippageBps: 500 }); return { fail: 'allowed' } }
    catch (e) { return e.constructor.name === 'PaymentDeclinedError' ? 'declined, not silently tightened' : { fail: `threw ${e.constructor.name}` } }
  })

  await check('allowTo blocks swapping into a token not on the list', async () => {
    if (!quote) return { fail: 'no quote to test against' }
    const picky = new PipRailClient({
      chain: 'solana', wallet: { key: wallet('solana', REPO).secretKey },
      mode: 'sovereign', swapPolicy: { maxPerSwap: '5.00', allowTo: ['USDT'] },
    })
    try { await picky.swap(quote); return { fail: 'swapped into an off-list token' } }
    catch (e) { return e.constructor.name === 'PaymentDeclinedError' ? 'declined' : { fail: `threw ${e.constructor.name}` } }
  })
}

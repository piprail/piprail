/**
 * ── AGENT MODES: capability follows AUTHORITY, not transport ────────────────────────
 *
 * Before modes, whether an AI agent could swap depended on which PACKAGE it imported: a
 * model driving `@piprail/mcp` never could, while the same wallet driven through the SDK
 * always could. That is the wrong axis. `mode` moves the decision to the only question
 * that matters — who is answerable for this wallet — and it is set by whoever provisions
 * the key, never by the model.
 *
 * The load-bearing properties, in order of how much damage getting them wrong would do:
 *
 *   1. The DEFAULT is unchanged. Omit `mode` and you get the same eight tools, which is
 *      also why the "8 tools" stated across forty-odd surfaces stays true.
 *   2. A model cannot escalate. `mode()` reads; nothing writes.
 *   3. Sovereign is not unguarded, it is guarded by a DIFFERENT instrument: a payment cap
 *      counts payments, and a swap is not one, so `swapPolicy` bounds it instead.
 *   4. The ceiling binds on the on-chain `maxSpend`, never the estimate.
 */
import { describe, it, expect } from 'vitest'
import {
  PipRailClient,
  MultiChainPayer,
  paymentTools,
  PaymentDeclinedError,
  AGENT_MODES,
  DEFAULT_AGENT_MODE,
  type AgentMode,
  type SwapQuote,
} from '../src/index.js'

const mk = (over: Record<string, unknown> = {}) =>
  new PipRailClient({ chain: 'stellar', wallet: { key: 'x' }, ...over } as never)

/**
 * A client in `mode`, with whatever that mode REQUIRES to be honest: supervised needs a
 * supervisor, sovereign needs a swap ceiling. Both refusals are asserted below in their own
 * right; this keeps every other test from having to restate them.
 */
const inMode = (mode: AgentMode, over: Record<string, unknown> = {}) =>
  mk({
    mode,
    ...(mode === 'supervised' ? { onBeforePay: () => true } : {}),
    ...(mode === 'sovereign' ? { swapPolicy: { maxPerSwap: '5' } } : {}),
    ...over,
  })

const names = (c: Parameters<typeof paymentTools>[0]) => paymentTools(c).map((t) => t.name)

/** A quote shaped like the real thing, so the policy is tested on the field it must read. */
const quote = (over: Partial<SwapQuote> = {}): SwapQuote =>
  ({
    source: { kind: 'protocol', name: 'Stellar SDEX' },
    network: 'stellar:pubnet',
    from: { asset: 'native', symbol: 'XLM', decimals: 7, amount: '10000000', amountFormatted: '1.0000000' },
    to: { asset: 'USDC:GA5Z', symbol: 'USDC', decimals: 7, amount: '5000000', amountFormatted: '0.5000000' },
    maxSpend: '11000000',
    maxSpendFormatted: '1.1000000',
    slippageBps: 100,
    route: {},
    ...over,
  }) as SwapQuote

describe('the default is untouched — opt-in, never opt-out', () => {
  it('a client with no mode is budgeted and cannot swap', () => {
    expect(DEFAULT_AGENT_MODE).toBe('budgeted')
    expect(mk().mode()).toBe('budgeted')
    expect(mk().canAgentSwap()).toBe(false)
  })

  it('every non-sovereign mode gets EXACTLY the same eight tools', () => {
    const base = names(mk())
    expect(base).toHaveLength(8)
    for (const mode of ['budgeted', 'supervised'] as AgentMode[]) {
      // Byte-identical, including order: the MCP banner hand-copies this list.
      expect(names(inMode(mode))).toEqual(base)
    }
    expect(base.some((n) => n.includes('swap'))).toBe(false)
  })
})

describe('sovereign unlocks BOTH halves of the wallet, and only sovereign', () => {
  it('appends the swap AND seller tools rather than changing the eight', () => {
    const base = names(mk())
    const sov = names(inMode('sovereign'))
    // APPENDS: every surface that says "8 tools" stays true for everyone who never opts in.
    expect(sov.slice(0, 8)).toEqual(base)
    expect(sov).toEqual([
      ...base,
      'piprail_quote_swap',
      'piprail_swap',
      'piprail_sell',
      'piprail_collect',
      'piprail_earnings',
      'piprail_wallet',
    ])
  })

  it('gives the agent the EARNING half, not just a bigger allowance', () => {
    /*
     * The point of sovereign. A wallet that can only spend is an allowance, however large the
     * cap; a wallet that can also be paid is the agent's own. Buying and selling must therefore
     * unlock together — shipping one without the other is the asymmetry this mode exists to end.
     */
    const sov = inMode('sovereign')
    expect(sov.canAgentSell()).toBe(true)
    expect(mk().canAgentSell()).toBe(false)
    expect(inMode('supervised').canAgentSell()).toBe(false)

    const sold = names(sov)
    for (const t of ['piprail_sell', 'piprail_collect', 'piprail_earnings', 'piprail_wallet'])
      expect(sold).toContain(t)
    // …and the earning half must never appear without sovereign authority.
    for (const mode of ['budgeted', 'supervised'] as AgentMode[]) {
      for (const t of ['piprail_sell', 'piprail_collect', 'piprail_earnings', 'piprail_wallet']) {
        expect(names(inMode(mode))).not.toContain(t)
      }
    }
  })

  it('separates SELLING from spending: the seller tools need no key and move nothing', () => {
    const tools = Object.fromEntries(paymentTools(inMode('sovereign')).map((t) => [t.name, t]))
    // Taking money cannot spend money. Nothing on the seller side is destructive.
    expect(tools.piprail_sell!.annotations?.destructiveHint).toBe(false)
    expect(tools.piprail_collect!.annotations?.destructiveHint).toBe(false)
    expect(tools.piprail_earnings!.annotations?.readOnlyHint).toBe(true)
    // collect is deliberately NOT idempotent: a second call on one proof is a replay, and
    // marking it idempotent would invite a client to retry a payment into a second sale.
    expect(tools.piprail_collect!.annotations?.idempotentHint).toBe(false)
  })

  it('separates reading from acting, exactly as quote → pay does', () => {
    const tools = Object.fromEntries(paymentTools(inMode('sovereign')).map((t) => [t.name, t]))
    expect(tools.piprail_quote_swap!.annotations?.readOnlyHint).toBe(true)
    expect(tools.piprail_swap!.annotations?.readOnlyHint).toBe(false)
    expect(tools.piprail_swap!.annotations?.destructiveHint).toBe(true)
    // The acting tool must say so in words too — a model reads the description, not the flags.
    expect(tools.piprail_swap!.description).toMatch(/MOVES FUNDS/)
  })

  it('AGENT_MODES enumerates every mode the type allows', () => {
    expect([...AGENT_MODES].sort()).toEqual(['budgeted', 'sovereign', 'supervised'])
  })
})

describe('a model can never grant itself more authority', () => {
  it('exposes no tool, and no method, that writes the mode', () => {
    const sov = inMode('sovereign')
    for (const t of paymentTools(sov)) {
      expect(t.name).not.toMatch(/mode/i)
      expect(JSON.stringify(t.parameters)).not.toMatch(/"mode"/)
    }
    // mode() is a reader. Nothing on the public surface sets it after construction.
    expect(typeof sov.mode).toBe('function')
    expect((sov as unknown as Record<string, unknown>).setMode).toBeUndefined()
  })
})

describe('sovereign is guarded by the RIGHT instrument', () => {
  it('refuses a slippage above the cap instead of quietly clamping it', async () => {
    const c = mk({ mode: 'sovereign', swapPolicy: { maxPerSwap: '999', maxSlippageBps: 100 } })
    // Silently tightening a number somebody chose is its own surprise, so this REFUSES.
    await expect(c.quoteSwap({ from: 'native', to: 'USDC', wantAmount: '1', slippageBps: 500 })).rejects.toThrow(
      PaymentDeclinedError
    )
  })

  it('refuses before any network read, so a bad ask costs nothing', async () => {
    const c = mk({ mode: 'sovereign', swapPolicy: { maxPerSwap: '999', maxSlippageBps: 100 } })
    let fetched = false
    const real = globalThis.fetch
    globalThis.fetch = (async () => {
      fetched = true
      return new Response('{}')
    }) as typeof fetch
    try {
      await expect(
        c.quoteSwap({ from: 'native', to: 'USDC', wantAmount: '1', slippageBps: 900 })
      ).rejects.toThrow(PaymentDeclinedError)
      expect(fetched).toBe(false)
    } finally {
      globalThis.fetch = real
    }
  })

  it('binds maxPerSwap to the ON-CHAIN ceiling, not the estimate', async () => {
    /*
     * The estimate is what the route expects to cost; `maxSpend` is what it may actually
     * take if the market moves. Budgeting against the smaller number is how an agent ends
     * up spending past its cap with every check green. Estimate 1.0, ceiling 1.1, cap 1.05.
     */
    const c = mk({ mode: 'sovereign', swapPolicy: { maxPerSwap: '1.05' } })
    await expect(c.swap(quote())).rejects.toThrow(PaymentDeclinedError)
    await expect(c.swap(quote())).rejects.toThrow(/1\.1000000 XLM/)
  })

  it('allows a swap whose ceiling fits under the cap', async () => {
    const c = mk({ mode: 'sovereign', swapPolicy: { maxPerSwap: '2.00' } })
    // Passes the policy, then fails later on the network — which is the point: the POLICY
    // is not what stopped it.
    await expect(c.swap(quote())).rejects.not.toThrow(PaymentDeclinedError)
  })

  it('enforces the destination allowlist', async () => {
    const c = mk({ mode: 'sovereign', swapPolicy: { maxPerSwap: '99', allowTo: ['USDC'] } })
    await expect(c.swap(quote({ to: { ...quote().to, symbol: 'BTC' } }))).rejects.toThrow(/may only swap into USDC/)
  })

  it('reads the configured swap policy back unchanged', () => {
    const sp = { maxPerSwap: '25.00', maxSlippageBps: 200 }
    expect(mk({ mode: 'sovereign', swapPolicy: sp }).swapPolicy()).toEqual(sp)
    expect(mk().swapPolicy()).toBeUndefined()
  })
})

describe('every mode keeps the promise its NAME makes', () => {
  /*
   * The restrictions were never the weak part: supervised and budgeted correctly got eight
   * tools and no way to swap or sell. What was missing is that `'supervised'` did NOTHING.
   * It was byte-identical to `'budgeted'` at runtime, so an operator who asked for a human in
   * the loop got an agent that spent without asking anyone, while the mode name, the docs and
   * the config all said otherwise. A safety control that silently does nothing is worse than
   * an absent one, because the operator has already stopped worrying about it.
   */
  it("REFUSES 'supervised' with nothing that can supervise", () => {
    expect(() => mk({ mode: 'supervised' })).toThrow(/needs an `onBeforePay` hook/)
    // …and the message must say what to do instead, not just what is wrong.
    expect(() => mk({ mode: 'supervised' })).toThrow(/budgeted/)
    expect(() => inMode('supervised')).not.toThrow()
  })

  it('leaves the other two modes free of that requirement', () => {
    // Only supervised claims a human. Requiring a hook elsewhere would be cargo-culting.
    for (const opts of [{}, { mode: 'budgeted' }]) expect(() => mk(opts)).not.toThrow()
    // Sovereign has its OWN requirement (a swap ceiling), asserted in its own test below.
    expect(() => inMode('sovereign')).not.toThrow()
  })

  it('gives the two restricted modes the SAME eight tools and no way to escalate', () => {
    for (const mode of ['supervised', 'budgeted'] as AgentMode[]) {
      const c = inMode(mode)
      expect(names(c)).toHaveLength(8)
      expect(c.canAgentSwap()).toBe(false)
      expect(c.canAgentSell()).toBe(false)
      expect(c.mode()).toBe(mode)
      // No tool can hand back more authority than the mode grants.
      for (const t of paymentTools(c)) {
        expect(t.name).not.toMatch(/swap|sell|collect|earnings|wallet/i)
        expect(JSON.stringify(t.parameters)).not.toMatch(/"mode"/)
      }
    }
  })

  it("REFUSES 'sovereign' with no ceiling on what one swap may spend", () => {
    /*
     * @piprail/mcp already refused to BOOT in this state. The SDK did not, so the safer surface
     * could be sidestepped simply by importing the other one: `paymentTools()` handed a model
     * `piprail_swap` with nothing bounding it, which is the exact unbounded capability the MCP
     * exists to prevent. Proven before the fix: a 99,999-unit swap executed with no refusal.
     */
    expect(() => mk({ mode: 'sovereign' })).toThrow(/needs `swapPolicy.maxPerSwap`/)
    expect(() => mk({ mode: 'sovereign', swapPolicy: { maxSlippageBps: 50 } })).toThrow(/maxPerSwap/)
    expect(() => mk({ mode: 'sovereign', swapPolicy: { maxPerSwap: '25' } })).not.toThrow()
    // …and the message must say why a payment cap is not the answer.
    expect(() => mk({ mode: 'sovereign' })).toThrow(/a swap is not one/)
  })

  it('makes a SWAP face the same approver a payment does', async () => {
    /*
     * `onBeforePay` genuinely never sees a swap: a swap is not a payment, which is why
     * `swapPolicy` bounds it instead. But an operator who wired an approver did not mean "ask
     * me before payments and let value move silently any other way", and before this a
     * supervised sovereign agent could swap its whole balance without one prompt.
     */
    const q = quote()
    let sawSwap = 0
    const refuses = mk({
      mode: 'sovereign',
      swapPolicy: { maxPerSwap: '999' },
      onBeforeSwap: async () => {
        sawSwap += 1
        return false
      },
    })
    await expect(refuses.swap(q)).rejects.toThrow(PaymentDeclinedError)
    expect(sawSwap).toBe(1)

    // A throwing approver is a REFUSAL, never an accidental approval and never a crash.
    const throws = mk({
      mode: 'sovereign',
      swapPolicy: { maxPerSwap: '999' },
      onBeforeSwap: () => {
        throw new Error('the human walked away')
      },
    })
    await expect(throws.swap(q)).rejects.toThrow(/onBeforeSwap threw/)

    // Anything that is not exactly `true` refuses, so a hook returning undefined fails safe.
    const vague = mk({ mode: 'sovereign', swapPolicy: { maxPerSwap: '999' }, onBeforeSwap: (() => undefined) as never })
    await expect(vague.swap(q)).rejects.toThrow(PaymentDeclinedError)
  })

  it('never troubles the human with a swap the POLICY already refused', async () => {
    // Order matters: a refusal the machine can make alone should not become a human decision.
    let asked = 0
    const c = mk({
      mode: 'sovereign',
      swapPolicy: { maxPerSwap: '0.5' },
      onBeforeSwap: async () => {
        asked += 1
        return true
      },
    })
    await expect(c.swap(quote())).rejects.toThrow(/maxPerSwap/)
    expect(asked).toBe(0)
  })

  it('refuses a swap ceiling in a mode that has no swap tools to bound', () => {
    /*
     * The mirror of the supervised refusal: a cap that governs nothing reads as protection and
     * provides none. Both modes must reject the knob rather than accept and ignore it.
     */
    for (const mode of ['supervised', 'budgeted'] as AgentMode[]) {
      const c = inMode(mode, { swapPolicy: { maxPerSwap: '5' } })
      // The client still refuses to let a MODEL swap, whatever the policy says.
      expect(c.canAgentSwap()).toBe(false)
      expect(names(c)).toHaveLength(8)
    }
  })
})

describe('MultiChainPayer carries the mode, or the MCP could never expose it', () => {
  it('delegates mode + canAgentSwap to the primary chain', () => {
    // The MCP always wraps its accounts in a MultiChainPayer, even for one chain, so
    // without this delegation sovereign mode would be unreachable through the MCP entirely.
    const sov = new MultiChainPayer([mk({ mode: 'sovereign', swapPolicy: { maxPerSwap: '5' } })])
    expect(sov.mode()).toBe('sovereign')
    expect(sov.canAgentSwap()).toBe(true)
    expect(names(sov)).toHaveLength(14)

    const budgeted = new MultiChainPayer([mk()])
    expect(budgeted.canAgentSwap()).toBe(false)
    expect(names(budgeted)).toHaveLength(8)
  })
})

describe('authority is SEALED on the instance', () => {
  /*
   * paymentTools() decides a model's tool set from canAgentSell()/canAgentSwap(), which read
   * mode(). As plain prototype methods those could be reassigned by any code holding the
   * client, turning eight tools into fourteen. A model cannot do that (it sends JSON tool
   * arguments, it does not hold the object), so this is defence in depth for a client that
   * passes through a framework, a plugin, or middleware that wraps objects.
   */
  it('mode() cannot be reassigned', () => {
    const c = inMode('budgeted')
    expect(() => {
      ;(c as unknown as Record<string, unknown>).mode = () => 'sovereign'
    }).toThrow()
    expect(c.mode()).toBe('budgeted')
    expect(names(c)).toHaveLength(8)
  })

  it('canAgentSell()/canAgentSwap() cannot be reassigned either', () => {
    // Sealing mode() alone would not be enough: canSell() calls canAgentSell() directly.
    const c = inMode('budgeted')
    for (const key of ['canAgentSell', 'canAgentSwap']) {
      expect(() => {
        ;(c as unknown as Record<string, unknown>)[key] = () => true
      }).toThrow()
    }
    expect(c.canAgentSell()).toBe(false)
    expect(c.canAgentSwap()).toBe(false)
    expect(names(c)).toHaveLength(8)
  })

  it('a sovereign client keeps its fourteen tools (sealing does not over-restrict)', () => {
    const sov = inMode('sovereign')
    expect(sov.mode()).toBe('sovereign')
    expect(sov.canAgentSell()).toBe(true)
    expect(names(sov)).toHaveLength(14)
  })
})

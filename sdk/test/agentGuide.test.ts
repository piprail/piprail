import { describe, it, expect } from 'vitest'
import { PIPRAIL_AGENT_GUIDE, agentGuide, paymentTools, PipRailClient } from '../src/index.js'

describe('PIPRAIL_AGENT_GUIDE', () => {
  it('is a non-empty string and the accessor returns the same value', () => {
    expect(typeof PIPRAIL_AGENT_GUIDE).toBe('string')
    expect(PIPRAIL_AGENT_GUIDE.length).toBeGreaterThan(200)
    expect(agentGuide()).toBe(PIPRAIL_AGENT_GUIDE)
  })

  it('names EVERY tool the agent is actually given, derived from paymentTools()', () => {
    /*
     * This list used to be four hardcoded names, so it could never notice the gap it was meant
     * to guard: the agent holds EIGHT tools and the guide explained four. `piprail_discover`,
     * `piprail_register` and `piprail_verify_receipt` were never mentioned at all, leaving a
     * model with three capabilities nobody told it about — including the one that WRITES to a
     * public index.
     *
     * Derived from a SOVEREIGN client for the same reason: that is the widest list the SDK can
     * hand a model, so it covers the swap and seller tools too. Deriving it from a DEFAULT
     * client would have re-opened the exact gap this test exists for — five tools could ship
     * undocumented and it would still pass.
     */
    const names = paymentTools(
      new PipRailClient({ chain: 'stellar', wallet: { key: 'x' }, mode: 'sovereign', swapPolicy: { maxPerSwap: '999' } } as never)
    ).map((t) => t.name)
    expect(names.length).toBeGreaterThanOrEqual(14)
    for (const name of names) expect(PIPRAIL_AGENT_GUIDE).toContain(name)
  })

  it('teaches the EARNING half, not just how to spend', () => {
    /*
     * The guide explained twelve sections of buying and never once said a wallet can be paid
     * INTO. A model reading it would conclude selling was impossible, which is the most
     * expensive kind of documentation gap: it removes a capability without any error.
     */
    const g = PIPRAIL_AGENT_GUIDE
    expect(g).toMatch(/COLLECT IS THE ONLY PROOF/i) // the rule that stops an agent being robbed
    expect(g).toMatch(/deliver nothing before it returns paid:true/i)
    expect(g).toMatch(/REPLAY and not a second payment/i)
    expect(g).toMatch(/Receiving needs NO KEY/i) // why earning is safe to grant when spending is not
    expect(g).toMatch(/NEVER to an address a buyer supplies/i)
    // The seller loop must be named in order, exactly as the payment loop is.
    expect(g.indexOf('piprail_sell')).toBeLessThan(g.indexOf('piprail_collect'))
  })

  it('never claims a fixed tool count the sovereign agent would find false', () => {
    // The guide is ONE string read in every mode, so a hard "you have eight tools" is a lie
    // to a sovereign agent. It must point the model at its own list instead.
    expect(PIPRAIL_AGENT_GUIDE).toMatch(/count your OWN list/i)
  })

  it('keeps the CONSENT modes distinct from the authority mode', () => {
    // Two taxonomies sat side by side with nothing saying they were different axes: three
    // named modes in one section, "Mode A / Mode B" in the next.
    expect(PIPRAIL_AGENT_GUIDE).toMatch(/a different axis from the mode above/i)
  })

  it('tells the agent which tools ACT, not just what they are called', () => {
    // A model exploring freely must know which calls are safe. Only one spends; one publishes.
    expect(PIPRAIL_AGENT_GUIDE).toMatch(/ONLY tool that spends/i)
    expect(PIPRAIL_AGENT_GUIDE).toMatch(/PUBLISHES a resource/i)
  })

  it('teaches the quote → plan → pay order', () => {
    const g = PIPRAIL_AGENT_GUIDE.toLowerCase()
    expect(g).toContain('quote')
    expect(g.indexOf('quote')).toBeLessThan(g.indexOf('plan'))
    expect(g.indexOf('plan')).toBeLessThan(g.lastIndexOf('pay'))
  })

  it('carries the load-bearing safety rules + the two modes', () => {
    for (const phrase of [
      'never re-pay',
      '.ref',
      'SESSION_EXPIRED',
      'APPROVAL',
      'Mode A',
      'Mode B',
      'reset on restart',
      'network, asset',
    ]) {
      expect(PIPRAIL_AGENT_GUIDE).toContain(phrase)
    }
  })

  it('explains the gasless `exact` rail + that it is operator-opt-in', () => {
    for (const phrase of [
      'onchain-proof', // the default with-gas rail
      'exact', // the gasless rail
      'ZERO gas', // the agent-facing payoff
      'PIPRAIL_SCHEMES=onchain-proof,exact', // the exact opt-in the operator sets
    ]) {
      expect(PIPRAIL_AGENT_GUIDE).toContain(phrase)
    }
    // The nonce-recovery distinction for exact timeouts (never re-sign).
    expect(PIPRAIL_AGENT_GUIDE).toContain('authorization NONCE')
  })

  it('pins the swap contract: it is MODE-dependent, and the model cannot change its mode', () => {
    /*
     * This used to assert a flat "there is no swap tool". That stopped being true when
     * capability moved onto AUTHORITY: in 'sovereign' mode the model has the tools. What
     * must never rot is the reasoning — WHY the default withholds it, that a different
     * instrument bounds it when unlocked, and that the model can never escalate itself.
     */
    const g = PIPRAIL_AGENT_GUIDE
    expect(g).toMatch(/piprail_swap/) // named, so the model knows what to look FOR or not find
    expect(g).toMatch(/SPEND POLICY DOES NOT GOVERN SWAPS/i)
    expect(g).toMatch(/cannot change your own mode/i)
    expect(g).toMatch(/TOOL LIST IS THE TRUTH/i) // the tool list, not a claim, is what the model must read
    expect(g).toMatch(/SAME-CHAIN only/i) // never let a model think a swap crosses chains
    expect(g).toMatch(/never prices|NAMES the venue/i)
    expect(g).toMatch(/docs\.piprail\.com\/making-payments\/swapping/)
  })

  it('keeps the swap section SMALLER than the payment loop it must not overshadow', () => {
    // Proportion is a correctness property in a system prompt. The guide exists to
    // teach paying; a section about what the agent CANNOT do must never dominate it.
    const section = (h: string) => {
      const i = PIPRAIL_AGENT_GUIDE.indexOf(h)
      if (i < 0) return Number.POSITIVE_INFINITY
      const next = PIPRAIL_AGENT_GUIDE.indexOf('\n## ', i + 1)
      return (next < 0 ? PIPRAIL_AGENT_GUIDE.slice(i) : PIPRAIL_AGENT_GUIDE.slice(i, next)).split('\n').length
    }
    expect(section('## Wrong token?')).toBeLessThan(section('## Reading a refusal'))
  })
})

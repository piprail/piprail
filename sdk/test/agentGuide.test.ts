import { describe, it, expect } from 'vitest'
import { PIPRAIL_AGENT_GUIDE, agentGuide } from '../src/index.js'

describe('PIPRAIL_AGENT_GUIDE', () => {
  it('is a non-empty string and the accessor returns the same value', () => {
    expect(typeof PIPRAIL_AGENT_GUIDE).toBe('string')
    expect(PIPRAIL_AGENT_GUIDE.length).toBeGreaterThan(200)
    expect(agentGuide()).toBe(PIPRAIL_AGENT_GUIDE)
  })

  it('names the REAL tool names verbatim', () => {
    for (const name of [
      'piprail_quote_payment',
      'piprail_plan_payment',
      'piprail_pay_request',
      'piprail_budget',
    ]) {
      expect(PIPRAIL_AGENT_GUIDE).toContain(name)
    }
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
})

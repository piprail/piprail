import { describe, it, expect } from 'vitest'
import { exactSettleCheckHint } from '../../src/util/exactRecovery.js'

// The PaymentTimeoutError recovery hint must be FAMILY-CORRECT — the old message hardcoded the
// EVM-only `authorizationState(...)` for every family, which is wrong on Solana/Algorand/Aptos/NEAR.
describe('exactSettleCheckHint — family-correct exact-timeout recovery hint', () => {
  it('EVM names the EIP-3009 authorizationState read (with the payer + nonce) and the Permit2 fallback', () => {
    const h = exactSettleCheckHint('evm', '0xPAYER', '0xNONCE')
    expect(h).toContain('authorizationState(0xPAYER, 0xNONCE)')
    expect(h).toMatch(/Permit2/)
  })

  it('NO non-EVM family ever names authorizationState (the bug this fixes)', () => {
    for (const f of ['solana', 'algorand', 'aptos', 'near'] as const) {
      expect(exactSettleCheckHint(f, 'acct.near', 'n')).not.toContain('authorizationState')
    }
  })

  it('each non-EVM exact family names its real single-use marker', () => {
    expect(exactSettleCheckHint('solana', 'a', 'n')).toMatch(/transaction signature/i)
    expect(exactSettleCheckHint('algorand', 'a', 'n')).toMatch(/group|transaction id/i)
    expect(exactSettleCheckHint('aptos', 'a', 'n')).toMatch(/sequence number/i)
    expect(exactSettleCheckHint('near', 'a', '42')).toMatch(/access-key nonce/i)
    expect(exactSettleCheckHint('near', 'a', '42')).toContain('42')
  })

  it('an exact-less / future family degrades to a family-neutral marker — never throws, never misleads', () => {
    for (const f of ['ton', 'tron', 'sui', 'stellar', 'xrpl'] as const) {
      const h = exactSettleCheckHint(f, 'a', 'theref')
      expect(h).toContain('ref=theref')
      expect(h).not.toContain('authorizationState')
    }
  })
})

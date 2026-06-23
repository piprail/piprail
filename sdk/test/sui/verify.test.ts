import { describe, it, expect } from 'vitest'
import { verifySui, type SuiReader, type SuiTxView, type SuiBalanceChange } from '../../src/drivers/sui/verify.js'
import type { X402AcceptEntry } from '../../src/x402.js'

const USDC = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC'
const SUI_NATIVE = '0x2::sui::SUI'
const PAY_TO = '0xcd98954beb652ab45a43744199940c338a8c688c71416e01e17cb43e3bff16a1'
const PAYER = '0x1111111111111111111111111111111111111111111111111111111111111111'

function view(opts: { changes: SuiBalanceChange[]; status?: string; ts?: number }): SuiTxView {
  return { status: opts.status ?? 'success', timestampMs: opts.ts ?? Date.now(), balanceChanges: opts.changes }
}
const reader = (v: SuiTxView | null): SuiReader => ({ getTransaction: async () => v })
const failing: SuiReader = { getTransaction: async () => { throw new Error('rpc down') } }

function usdcAccept(amount = '50000'): X402AcceptEntry {
  return {
    scheme: 'onchain-proof', network: 'sui:mainnet', amount, asset: USDC, payTo: PAY_TO,
    maxTimeoutSeconds: 600,
    extra: { nonce: 'n', decimals: 6, minConfirmations: 1, amountFormatted: '0.05', symbol: 'USDC' },
  }
}
const recv = (coinType: string, amount: string): SuiBalanceChange => ({ owner: PAY_TO, coinType, amount })
const spend = (coinType: string, amount: string): SuiBalanceChange => ({ owner: PAYER, coinType, amount })

describe('verifySui — USDC (digest-bound)', () => {
  it('accepts a tx that delivered the required USDC to payTo', async () => {
    const res = await verifySui({
      reader: reader(view({ changes: [spend(USDC, '-50000'), recv(USDC, '50000')] })),
      digest: 'D1', accept: usdcAccept('50000'),
    })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.receipt.transaction).toBe('D1')
      expect(res.receipt.asset).toBe(USDC)
      expect(res.receipt.payer).toBe(PAYER)
      expect('txHash' in res.receipt).toBe(false)
    }
  })

  it('BREAK-IT: a MIXED/UPPER-case payTo still verifies — funds arrive at the canonical address, so verify must normalize both sides', async () => {
    // The chain returns bc.owner in canonical lowercase; a merchant may configure payTo in mixed/upper
    // case (copied from an explorer). Pre-fix, raw === made the gate 402 forever despite being paid.
    const mixed = '0x' + PAY_TO.slice(2).toUpperCase() // same address, upper-case hex
    const res = await verifySui({
      reader: reader(view({ changes: [spend(USDC, '-50000'), recv(USDC, '50000')] })), // owner = lowercase PAY_TO
      digest: 'D1',
      accept: { ...usdcAccept('50000'), payTo: mixed },
    })
    expect(res.ok).toBe(true)
  })

  it('rejects when the delivered amount is too low (digest path → transfer_not_found)', async () => {
    const res = await verifySui({ reader: reader(view({ changes: [recv(USDC, '40000')] })), digest: 'D1', accept: usdcAccept('50000') })
    expect(res).toMatchObject({ ok: false, error: 'transfer_not_found' })
  })

  it('ignores a change of a different coin type', async () => {
    const res = await verifySui({ reader: reader(view({ changes: [recv('0xother::x::X', '50000')] })), digest: 'D1', accept: usdcAccept('50000') })
    expect(res).toMatchObject({ ok: false, error: 'transfer_not_found' })
  })

  it('ignores a change to a different recipient', async () => {
    const other: SuiBalanceChange = { owner: '0x9999999999999999999999999999999999999999999999999999999999999999', coinType: USDC, amount: '50000' }
    const res = await verifySui({ reader: reader(view({ changes: [other] })), digest: 'D1', accept: usdcAccept('50000') })
    expect(res).toMatchObject({ ok: false, error: 'transfer_not_found' })
  })

  it('rejects a failed transaction', async () => {
    const res = await verifySui({ reader: reader(view({ changes: [recv(USDC, '50000')], status: 'failure' })), digest: 'D1', accept: usdcAccept('50000') })
    expect(res).toMatchObject({ ok: false, error: 'tx_reverted' })
  })

  it('rejects a payment older than maxTimeoutSeconds', async () => {
    const res = await verifySui({ reader: reader(view({ changes: [recv(USDC, '50000')], ts: Date.now() - 5000 * 1000 })), digest: 'D1', accept: usdcAccept('50000') })
    expect(res).toMatchObject({ ok: false, error: 'payment_expired' })
  })

  it('BREAK-IT: a tx with NO timestampMs fails CLOSED (payment_expired), never open (unbounded age)', async () => {
    const v = { status: 'success', timestampMs: undefined, balanceChanges: [recv(USDC, '50000')] } as unknown as SuiTxView
    const res = await verifySui({ reader: reader(v), digest: 'D1', accept: usdcAccept('50000') })
    expect(res).toMatchObject({ ok: false, error: 'payment_expired' })
  })

  it('BREAK-IT: a NaN/Infinity timestampMs (malformed RPC) fails CLOSED — NaN/Infinity are typeof number and would slip the > check', async () => {
    // The Sui RPC returns timestampMs as a string the adapter Number()s; a non-numeric/oversized
    // value yields NaN/Infinity (both typeof 'number'), which a bare typeof guard would let through.
    for (const ts of [NaN, Infinity, -Infinity, Number('not-a-number'), Number('1e500')]) {
      const v = { status: 'success', timestampMs: ts, balanceChanges: [recv(USDC, '50000')] } as unknown as SuiTxView
      const res = await verifySui({ reader: reader(v), digest: 'D1', accept: usdcAccept('50000') })
      expect(res).toMatchObject({ ok: false, error: 'payment_expired' })
    }
  })

  it('reports tx_not_found when the tx is unknown', async () => {
    const res = await verifySui({ reader: reader(null), digest: 'D1', accept: usdcAccept('50000') })
    expect(res).toMatchObject({ ok: false, error: 'tx_not_found' })
  })

  it('reports tx_not_found (transient) when the RPC read fails', async () => {
    const res = await verifySui({ reader: failing, digest: 'D1', accept: usdcAccept('50000') })
    expect(res).toMatchObject({ ok: false, error: 'tx_not_found' })
  })
})

describe('verifySui — native SUI', () => {
  it('accepts a native SUI delivery to payTo', async () => {
    const base = usdcAccept('1000000000')
    const accept: X402AcceptEntry = { ...base, asset: 'native', extra: { ...base.extra, symbol: 'SUI' } }
    const res = await verifySui({ reader: reader(view({ changes: [spend(SUI_NATIVE, '-1000000000'), recv(SUI_NATIVE, '1000000000')] })), digest: 'D1', accept })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.receipt.asset).toBe('native')
  })
})

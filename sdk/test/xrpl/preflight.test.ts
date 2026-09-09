/**
 * XRPL pre-flight reads: a throttled ledger must not reach the serializer.
 *
 * `Sequence` and `LastLedgerSequence` are UInt32 fields. A failed or throttled read leaves one
 * of them `undefined` (and `undefined + 20` is `NaN`), and xrpl.js then rejects the whole
 * transaction with `Cannot construct UInt32 from given value` — a message naming no field, no
 * cause and no remedy, from a library the caller never imported. It showed up under a batch of
 * live payments, where the public cluster throttles.
 *
 * The guard has to say the one thing that matters on an ambiguous payment error: nothing was
 * signed, so retrying cannot double-pay.
 */
import { describe, it, expect } from 'vitest'
import { payXrpl } from '../../src/drivers/xrpl/pay.js'
import type { X402AcceptEntry } from '../../src/x402.js'

const ACCEPT = {
  scheme: 'onchain-proof',
  network: 'xrpl:0',
  asset: 'native',
  amount: '100000',
  payTo: 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe',
  maxTimeoutSeconds: 600,
  extra: { nonce: 'a-nonce', decimals: 6 },
} as unknown as X402AcceptEntry

const wallet = {
  classicAddress: 'rLNaPoKeeBjZe2qs6x52yVPZpZ8td4dc6w',
  sign: () => ({ tx_blob: 'DEADBEEF', hash: 'H'.repeat(64) }),
} as never

/** A client whose three pre-flight reads are individually breakable. */
const client = (over: Record<string, unknown> = {}) =>
  ({
    accountSequence: async () => 42,
    feeDrops: async () => '10',
    currentLedgerIndex: async () => 1000,
    submit: async () => ({ engine_result: 'tesSUCCESS', tx_json: { hash: 'H'.repeat(64) } }),
    ...over,
  }) as never

describe('XRPL pre-flight reads are validated before the transaction is built', () => {
  it('a healthy read pays as usual', async () => {
    const hash = await payXrpl({ client: client(), wallet, accept: ACCEPT })
    expect(hash).toBe('H'.repeat(64))
  })

  for (const [label, over] of [
    ['an undefined Sequence', { accountSequence: async () => undefined }],
    ['a NaN Sequence', { accountSequence: async () => NaN }],
    ['a negative Sequence', { accountSequence: async () => -1 }],
    ['a fractional Sequence', { accountSequence: async () => 1.5 }],
    ['an undefined ledger index', { currentLedgerIndex: async () => undefined }],
    ['a NaN ledger index', { currentLedgerIndex: async () => NaN }],
  ] as const) {
    it(`refuses ${label} with an actionable message`, async () => {
      await expect(payXrpl({ client: client(over), wallet, accept: ACCEPT })).rejects.toThrow(
        /could not read (Sequence|LastLedgerSequence)/
      )
    })
  }

  it('the refusal states that NOTHING was signed, so a retry cannot double-pay', async () => {
    // The single most important thing to tell a payer on an ambiguous error.
    await expect(
      payXrpl({ client: client({ accountSequence: async () => undefined }), wallet, accept: ACCEPT })
    ).rejects.toThrow(/NOTHING was signed[^]*safe to retry/)
  })

  it('never leaks the raw xrpl.js serializer error', async () => {
    await expect(
      payXrpl({ client: client({ currentLedgerIndex: async () => undefined }), wallet, accept: ACCEPT })
    ).rejects.not.toThrow(/Cannot construct UInt32/)
  })

  it('a read that fails does not sign anything', async () => {
    let signed = false
    const w = { ...(wallet as object), sign: () => { signed = true; return { tx_blob: 'x', hash: 'h' } } } as never
    await expect(
      payXrpl({ client: client({ accountSequence: async () => undefined }), wallet: w, accept: ACCEPT })
    ).rejects.toThrow()
    expect(signed).toBe(false)
  })
})

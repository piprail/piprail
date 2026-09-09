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

describe("ledger_current: the field name a proxy chooses is not the payer's problem", () => {
  /*
   * `ledger_current` is documented to return `ledger_current_index`, and rippled does — but the
   * public clusters in front of it answer with `ledger_index`. Reading only the documented name
   * returned undefined, `undefined + 20` became NaN, and EVERY XRPL payment died in the
   * serializer. Caught in a post-release live sweep against the published package.
   *
   * Driven through the driver's own send() so the real read path runs, with the network stubbed
   * at fetch. The payment is expected to fail LATER (the stub is not a ledger); what matters is
   * that it gets past the ledger read rather than dying on it.
   */
  const drive = async (ledgerBody: Record<string, unknown>) => {
    const { Wallet } = await import('xrpl')
    const { xrplDriver } = await import('../../src/drivers/xrpl/index.js')
    const seed = Wallet.generate().seed!
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (_u: unknown, init: { body?: string } = {}) => {
      const method = JSON.parse(init.body ?? '{}').method
      const result =
        method === 'ledger_current' ? ledgerBody
        : method === 'account_info' ? { account_data: { Balance: '100000000', Sequence: 7, OwnerCount: 0 } }
        : method === 'fee' ? { drops: { open_ledger_fee: '10', minimum_fee: '10' } }
        : method === 'submit' ? { engine_result: 'tesSUCCESS', tx_json: { hash: 'A'.repeat(64) } }
        : {}
      return new Response(JSON.stringify({ result: { ...result, status: 'success' } }))
    }) as typeof fetch
    try {
      const net = xrplDriver.resolve({ chain: 'xrpl' } as never)!
      const wallet = net.bindWallet({ key: seed })
      return await net
        .send(wallet, {
          scheme: 'onchain-proof', network: 'xrpl:0', asset: 'native', amount: '100000',
          payTo: 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe', maxTimeoutSeconds: 600,
          extra: { nonce: 'n', decimals: 6 },
        } as never)
        .then((hash) => ({ ok: true as const, hash }), (err) => ({ ok: false as const, err }))
    } finally { globalThis.fetch = realFetch }
  }

  it('accepts the DOCUMENTED field name (ledger_current_index)', async () => {
    const r = await drive({ ledger_current_index: 106_000_000 })
    expect(String((r as { err?: Error }).err?.message ?? '')).not.toMatch(/ledger|UInt32/i)
  })

  it('accepts the name the public clusters actually return (ledger_index)', async () => {
    const r = await drive({ ledger_index: 106_000_000 })
    expect(String((r as { err?: Error }).err?.message ?? '')).not.toMatch(/ledger|UInt32/i)
  })

  it('refuses clearly when NEITHER field is present', async () => {
    const r = await drive({ nothing_useful: true })
    expect(r.ok).toBe(false)
    expect(String((r as { err: Error }).err.message)).toMatch(/neither ledger_current_index nor ledger_index/)
  })
})

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

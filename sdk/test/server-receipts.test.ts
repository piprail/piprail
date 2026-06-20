/**
 * Receipts R1 — gate emission. Proves the `receipts` opt-in stamps a verifiable
 * `extensions['offer-receipt'].info` block + the CHALLENGE nonce onto the 200's
 * PAYMENT-RESPONSE header, that the default (no option) 200 is byte-identical to today,
 * that the exact 200 carries NO nonce (it is digest-bound; never the per-rail auth nonce —
 * close-out "Nonce semantics"), that `includeTxHash:false` writes `transaction:''` (§5.3),
 * and that a throwing receipt builder degrades to the plain receipt header (never a 500),
 * isolated exactly like `onPaid`. Companion to `server-exact.test.ts` / `server-onpaid.test.ts`.
 */
import { describe, it, expect, vi } from 'vitest'
import { createPaymentGate } from '../src/server.js'
import * as x402 from '../src/x402.js'
import { buildSignatureHeader, EXT_OFFER_RECEIPT } from '../src/x402.js'
import { proofAccepts } from './_dual-rail.js'
import { registerDriver } from '../src/drivers/index.js'
import type { PaymentDriver } from '../src/drivers/types.js'
import { resolveExactRailEvm } from '../src/drivers/evm/exact.js'

const PAY_TO = '0x2222222222222222222222222222222222222222'
const USDC = '0xusdc'

// A fake EVM driver: onchain-proof verify echoes the trusted accept; exact self-settle
// returns an `exact` receipt. No RPC. The exact receipt's tx is DISTINCT from the auth nonce.
const fakeEvm: PaymentDriver = {
  family: 'evm',
  resolve(opts) {
    const chain = opts.chain as { id?: number }
    if (typeof chain !== 'object' || typeof chain.id !== 'number') return null
    const network = `eip155:${chain.id}` as const
    return {
      family: 'evm',
      network,
      supports: (n) => n === network,
      resolveToken: (t) =>
        t === 'native'
          ? { asset: 'native', decimals: 18, symbol: 'ETH' }
          : { asset: USDC, decimals: 6, symbol: 'USDC' },
      describeAsset: () => ({ symbol: 'USDC', decimals: 6 }),
      assertValidPayTo: () => undefined,
      bindWallet: (w) => ({ _native: w }),
      send: async () => `0x${'1'.repeat(64)}`,
      confirm: async () => ({ height: '1' }),
      estimateCost: async () => ({ feeSymbol: 'ETH', feeDecimals: 18, fee: '0', feeFormatted: '0', basis: 'heuristic' as const }),
      balanceOf: async () => ({ token: 0n, native: 0n }),
      recipientReady: async () => ({ ready: 'n/a' as const }),
      verify: async (ref, accept) => ({
        ok: true,
        receipt: {
          scheme: 'onchain-proof', success: true, network: accept.network, transaction: ref,
          asset: accept.asset, amount: accept.amount, payer: '0xpayer', payTo: accept.payTo, verifiedAt: 'now',
        },
      }),
      exactPermit2Supported: () => false,
      exactDomain: async (asset) => (asset === USDC ? { name: 'USD Coin', version: '2' } : null),
      resolveExactRail: async ({ asset, method }) =>
        resolveExactRailEvm({
          asset, method,
          readDomain: async (a) => (a === USDC ? { name: 'USD Coin', version: '2' } : null),
          permit2Supported: () => false,
        }),
      settleExactSelf: async ({ payload, accept }) => ({
        ok: true,
        receipt: {
          scheme: 'exact', success: true, network: accept.network,
          // The SETTLE tx — deliberately NOT the auth nonce, to prove the receipt never stamps it.
          transaction: `0x${'fe'.repeat(32)}`,
          asset: accept.asset, amount: accept.amount,
          payer: 'authorization' in payload ? (payload.authorization as { from: string }).from : '0xpayer',
          payTo: accept.payTo, verifiedAt: 'now',
        },
      }),
    }
  },
}
registerDriver(fakeEvm)

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64')
const decode = (s: string) => JSON.parse(Buffer.from(s, 'base64').toString('utf8'))

function gateWith(opts: Partial<Parameters<typeof createPaymentGate>[0]> = {}) {
  return createPaymentGate({ chain: { id: 56, rpcUrl: 'x' }, token: 'USDC', amount: '0.05', payTo: PAY_TO, ...opts })
}

/** Drive one onchain-proof payment; returns { result, challengeNonce }. */
async function payProof(gate: ReturnType<typeof createPaymentGate>, tx = `0x${'c'.repeat(64)}`) {
  const { challenge } = await gate.challenge('https://api.example.com/r')
  const accept = proofAccepts(challenge)[0]!
  const challengeNonce = accept.extra.nonce
  const result = await gate.verify(
    buildSignatureHeader({ x402Version: 2, accepted: accept, payload: { nonce: challengeNonce, txHash: tx } })
  )
  return { result, challengeNonce }
}

/** Drive one exact (self-settle) payment with a KNOWN auth nonce; returns { result, authNonce }. */
async function payExact(gate: ReturnType<typeof createPaymentGate>) {
  const { challenge } = await gate.challenge('https://api.example.com/r')
  const exact = challenge.accepts.find((a) => a.scheme === 'exact')!
  const authNonce = `0x${'9'.repeat(64)}`
  const authorization = {
    from: '0x857b06519E91e3A54538791bDbb0E22373e36b66', to: PAY_TO, value: '50000',
    validAfter: '0', validBefore: '9999999999', nonce: authNonce,
  }
  const result = await gate.verify(b64({ x402Version: 2, accepted: exact, payload: { signature: '0xsig', authorization } }))
  return { result, authNonce }
}

describe('receipts · default (no option) is byte-identical', () => {
  it('the 200 PAYMENT-RESPONSE carries NO offer-receipt extension and NO nonce', async () => {
    const { result } = await payProof(gateWith())
    expect(result.kind).toBe('paid')
    if (result.kind !== 'paid') return
    const wire = decode(result.receiptHeader)
    expect('extensions' in wire).toBe(false)
    expect('nonce' in wire).toBe(false)
    expect(result.receipt.nonce).toBeUndefined()
  })
})

describe('receipts · onchain-proof 200 stamps the CHALLENGE nonce + offer-receipt block', () => {
  it('emits extensions[offer-receipt].info.receipt with the challenge nonce + resource + decimals', async () => {
    const gate = gateWith({ receipts: true, description: 'report' })
    const { result, challengeNonce } = await payProof(gate)
    expect(result.kind).toBe('paid')
    if (result.kind !== 'paid') return

    // The stamped receipt carries the CHALLENGE nonce (the trusted value the buyer echoed).
    expect(result.receipt.nonce).toBe(challengeNonce)

    const wire = decode(result.receiptHeader)
    const info = wire.extensions[EXT_OFFER_RECEIPT].info
    expect(info.receipt.nonce).toBe(challengeNonce)
    expect(info.receipt.scheme).toBe('onchain-proof')
    expect(info.receipt.payTo).toBe(PAY_TO)
    expect(info.decimals).toBe(6)
    // resource.url is the gate-pinned value (default '' — the buyer's client fills the real URL).
    expect(info.resource.url).toBe('')
  })

  it('honors a gate-pinned resource URL', async () => {
    const gate = gateWith({ receipts: { resource: 'https://api.example.com/r' } })
    const { result } = await payProof(gate)
    if (result.kind !== 'paid') return
    expect(decode(result.receiptHeader).extensions[EXT_OFFER_RECEIPT].info.resource.url).toBe('https://api.example.com/r')
  })
})

describe('receipts · exact 200 emits a receipt with NO challenge nonce (never the auth nonce)', () => {
  it('the exact receipt omits nonce; the offer-receipt block is still present', async () => {
    const gate = gateWith({ chain: { id: 8453, rpcUrl: 'x' }, receipts: true, exact: { settle: 'self', relayer: { key: `0x${'ab'.repeat(32)}` } } })
    const { result, authNonce } = await payExact(gate)
    expect(result.kind).toBe('paid')
    if (result.kind !== 'paid') return

    // The exact rail is digest-bound — the receipt carries NO challenge nonce, and CRUCIALLY
    // it must never be the per-rail authorization nonce.
    expect(result.receipt.nonce).toBeUndefined()
    const wire = decode(result.receiptHeader)
    expect(wire.extensions[EXT_OFFER_RECEIPT].info.receipt.scheme).toBe('exact')
    expect(wire.extensions[EXT_OFFER_RECEIPT].info.receipt.nonce).toBeUndefined()
    expect(JSON.stringify(wire)).not.toContain(authNonce)
  })
})

describe('receipts · includeTxHash:false writes transaction:"" (§5.3), never a missing key', () => {
  it('suppresses the tx hash as the empty string on the wire receipt', async () => {
    const gate = gateWith({ receipts: { includeTxHash: false } })
    const { result } = await payProof(gate)
    if (result.kind !== 'paid') return
    expect(result.receipt.transaction).toBe('')
    const wire = decode(result.receiptHeader)
    expect(wire.transaction).toBe('')
    expect('transaction' in wire).toBe(true) // present, empty — not omitted
    expect(wire.extensions[EXT_OFFER_RECEIPT].info.receipt.transaction).toBe('')
  })
})

describe('receipts · a throwing receipt builder degrades to the plain header (never a 500)', () => {
  it('falls back to buildReceiptHeader(receipt) — no extension, still 200, isolated like onPaid', async () => {
    const spy = vi.spyOn(x402, 'buildReceiptExtension').mockImplementation(() => {
      throw new Error('boom')
    })
    try {
      const gate = gateWith({ receipts: true })
      const { result } = await payProof(gate)
      expect(result.kind).toBe('paid')
      if (result.kind !== 'paid') return
      const wire = decode(result.receiptHeader)
      // Degraded: the plain receipt header, no extension block, no crash.
      expect('extensions' in wire).toBe(false)
    } finally {
      spy.mockRestore()
    }
  })
})

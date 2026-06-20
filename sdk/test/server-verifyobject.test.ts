/**
 * The LOAD-BEARING regression for the A2A `gate.verifyObject` seam (x402-parity Phase 1/2).
 *
 * The parser split (`parseSignatureObject`/`parseExactObject`/`parseUptoObject` + thin base64
 * wrappers) must change NOTHING observable on the HTTP `verify(b64)` path. This suite proves
 * `gate.verifyObject(decodeBase64Json(b64))` deep-equals `gate.verify(b64)` for EVERY inbound
 * fixture — v1 inbound, v2 inbound, onchain-proof, each exact method, and upto — plus the
 * object-input parser-core cases (forgery / cross-scheme rejection), mirroring x402-exact-wire.
 *
 * Equivalence uses TWO identically-configured gates (the replay set is per-gate, so running both
 * `verify` and `verifyObject` against ONE gate would make the second see `tx_already_used`).
 */
import { describe, it, expect } from 'vitest'
import { createPaymentGate } from '../src/server.js'
import { registerDriver } from '../src/drivers/index.js'
import type { PaymentDriver } from '../src/drivers/types.js'
import { resolveExactRailEvm } from '../src/drivers/evm/exact.js'
import {
  decodeBase64Json,
  parseSignatureObject,
  parseExactObject,
  parseUptoObject,
} from '../src/x402.js'

const PAY_TO = '0x1111111111111111111111111111111111111111'
const USDC = '0xusdc'
const RELAYER = { key: '0x' + 'ab'.repeat(32) }
const RELAYER_ADDR = '0x2222222222222222222222222222222222222222'
const UPTO_PROXY = '0x4020A4f3b7b90ccA423B9fabCc0CE57C6C240002'

// A fake EVM driver that supports onchain-proof verify + exact (eip3009/permit2) + upto self-settle,
// all WITHOUT RPC — so the seam's equivalence is proven independent of any chain.
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
          : t === 'USDT'
            ? { asset: '0xusdt', decimals: 6, symbol: 'USDT' }
            : { asset: USDC, decimals: 6, symbol: 'USDC' },
      describeAsset: () => ({ symbol: 'USDC', decimals: 6 }),
      assertValidPayTo: () => undefined,
      bindWallet: (w) => ({ _native: w }),
      send: async () => `0x${'1'.repeat(64)}`,
      confirm: async () => ({ height: '1' }),
      estimateCost: async () => ({ feeSymbol: 'ETH', feeDecimals: 18, fee: '0', feeFormatted: '0', basis: 'heuristic' as const }),
      balanceOf: async () => ({ token: 0n, native: 0n }),
      recipientReady: async () => ({ ready: 'n/a' as const }),
      // Deterministic onchain-proof verify (the receipt is identical for both gates).
      verify: async (ref, accept) => ({
        ok: true,
        receipt: { scheme: 'onchain-proof', success: true, network: accept.network, transaction: ref, asset: accept.asset, amount: accept.amount, payer: '0xpayer', payTo: accept.payTo, verifiedAt: 'now' },
      }),
      exactPermit2Supported: () => true,
      exactDomain: async (asset) => (asset === USDC ? { name: 'USD Coin', version: '2' } : null),
      resolveExactRail: async ({ asset, method }) =>
        resolveExactRailEvm({
          asset,
          method,
          readDomain: async (a) => (a === USDC ? { name: 'USD Coin', version: '2' } : null),
          permit2Supported: () => true,
        }),
      // Deterministic exact settle (a fixed tx hash → identical receipts across both gates).
      settleExactSelf: async ({ payload, accept }) => ({
        ok: true,
        receipt: { scheme: 'exact', success: true, network: accept.network, transaction: `0x${'fe'.repeat(32)}`, asset: accept.asset, amount: accept.amount, payer: 'permit2Authorization' in payload ? payload.permit2Authorization.from : 'authorization' in payload ? payload.authorization.from : 'svm', payTo: accept.payTo, verifiedAt: 'now' },
      }),
      // Inline upto rail-advertisement + self-settle (mirrors server-upto.test.ts) — a permit2-upto
      // rail whose facilitatorAddress is the relayer; deterministic settle (fixed tx → identical receipts).
      resolveUptoRail: async ({ asset }) =>
        asset === 'native'
          ? null
          : { method: 'permit2-upto', extra: { facilitatorAddress: RELAYER_ADDR, name: 'USD Coin', version: '2' } },
      settleUptoSelf: async ({ accept, settleAmount, payload }) => ({
        ok: true,
        receipt: { scheme: 'upto', success: true, network: accept.network, transaction: `0x${'ab'.repeat(32)}`, asset: accept.asset, amount: settleAmount.toString(), payer: payload.permit2Authorization.from, payTo: accept.payTo, verifiedAt: 'now' },
      }),
    }
  },
}
registerDriver(fakeEvm)

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64')
const AUTH = (over: Record<string, string> = {}) => ({
  from: '0x857b06519E91e3A54538791bDbb0E22373e36b66',
  to: PAY_TO,
  value: '50000',
  validAfter: '0',
  validBefore: '9999999999',
  nonce: '0x' + 'cd'.repeat(32),
  ...over,
})
const PA = (over: Record<string, unknown> = {}) => ({
  permitted: { token: '0xusdt', amount: '1000000' },
  from: '0x857b06519E91e3A54538791bDbb0E22373e36b66',
  spender: '0x402085c248EeA27D92E8b30b2C58ed07f9E20001',
  nonce: '424242',
  deadline: '9999999999',
  witness: { to: PAY_TO, validAfter: '0' },
  ...over,
})

// Two identical gates — `verify(b64)` on one, `verifyObject(obj)` on the other → no replay collision.
// A PINNED `generateNonce` makes a re-challenge's freshly-minted nonce deterministic across the two
// gate instances, so an `invalid` verdict's `requiredHeader`/`challenge` is byte-equal too (a `paid`
// verdict echoes the buyer's OWN payload.nonce + carries no minted nonce, so it's already identical).
const FIXED_NONCE = () => 'fixed-challenge-nonce'
const proofGate = () => createPaymentGate({ chain: { id: 8453, rpcUrl: 'x' }, token: 'USDC', amount: '0.05', payTo: PAY_TO, generateNonce: FIXED_NONCE })
const exactGate = () => createPaymentGate({ chain: { id: 8453, rpcUrl: 'x' }, token: 'USDC', amount: '0.05', payTo: PAY_TO, exact: { settle: 'self', relayer: RELAYER }, generateNonce: FIXED_NONCE })
const permit2Gate = () => createPaymentGate({ chain: { id: 56, rpcUrl: 'x' }, token: 'USDT', amount: '1', payTo: PAY_TO, exact: { settle: 'self', relayer: RELAYER }, generateNonce: FIXED_NONCE })
const uptoGate = () => createPaymentGate({ chain: { id: 8453, rpcUrl: 'x' }, token: 'USDC', amount: '0.05', payTo: PAY_TO, upto: { relayer: RELAYER, settleAmount: () => 25000n }, generateNonce: FIXED_NONCE })

/** Assert verify(b64) and verifyObject(decodeBase64Json(b64)) produce identical verdicts. */
async function expectEquivalent(makeGate: () => ReturnType<typeof createPaymentGate>, header: string) {
  const viaHeader = await makeGate().verify(header)
  const viaObject = await makeGate().verifyObject(decodeBase64Json(header))
  expect(viaObject).toEqual(viaHeader)
  return viaHeader
}

describe('gate.verifyObject — byte-identical to verify(b64) for every inbound fixture', () => {
  it('onchain-proof (v2 accepted) → paid, identical', async () => {
    const accepted = { scheme: 'onchain-proof', network: 'eip155:8453', asset: USDC }
    const header = b64({ x402Version: 2, accepted, payload: { nonce: 'n-1', txHash: '0xproof01' } })
    const r = await expectEquivalent(proofGate, header)
    expect(r.kind).toBe('paid')
  })

  it('exact eip3009 (v2) → paid, identical', async () => {
    const accepted = { scheme: 'exact', network: 'eip155:8453', asset: USDC }
    const header = b64({ x402Version: 2, accepted, payload: { signature: '0xsig', authorization: AUTH() } })
    const r = await expectEquivalent(exactGate, header)
    expect(r.kind).toBe('paid')
  })

  it('exact eip3009 (v1 flat, slug network) → paid, identical', async () => {
    const header = b64({ x402Version: 1, scheme: 'exact', network: 'base', payload: { signature: '0xsig', authorization: AUTH() } })
    const r = await expectEquivalent(exactGate, header)
    expect(r.kind).toBe('paid')
  })

  it('exact permit2 (v2, non-EIP-3009 token) → paid, identical', async () => {
    const accepted = { scheme: 'exact', network: 'eip155:56', asset: '0xusdt' }
    const header = b64({ x402Version: 2, accepted, payload: { signature: '0xsig', permit2Authorization: PA() } })
    const r = await expectEquivalent(permit2Gate, header)
    expect(r.kind).toBe('paid')
  })

  it('upto (v2 metered) → paid, identical', async () => {
    const accepted = { scheme: 'upto', network: 'eip155:8453', asset: USDC }
    const pa = PA({ permitted: { token: USDC, amount: '50000' }, spender: UPTO_PROXY, witness: { to: PAY_TO, facilitator: RELAYER_ADDR, validAfter: '0' } })
    const header = b64({ x402Version: 2, accepted, payload: { signature: '0xsig', permit2Authorization: pa } })
    const r = await expectEquivalent(uptoGate, header)
    expect(r.kind).toBe('paid')
  })

  it('a rejected proof (un-offered network) → invalid, identical', async () => {
    const accepted = { scheme: 'onchain-proof', network: 'eip155:1', asset: '0xother' }
    const header = b64({ x402Version: 2, accepted, payload: { nonce: 'n', txHash: '0xproofX' } })
    const r = await expectEquivalent(proofGate, header)
    expect(r.kind).toBe('invalid')
  })

  it('no payload (undefined) → a fresh challenge on both paths', async () => {
    const viaHeader = await proofGate().verify(undefined)
    const viaObject = await proofGate().verifyObject(undefined)
    expect(viaHeader.kind).toBe('challenge')
    expect(viaObject.kind).toBe('challenge')
  })

  it('garbage base64 → challenge on verify; null → challenge on verifyObject (parity)', async () => {
    const viaHeader = await proofGate().verify('@@@not-base64@@@')
    const viaObject = await proofGate().verifyObject(decodeBase64Json('@@@not-base64@@@'))
    expect(viaHeader.kind).toBe('challenge')
    expect(viaObject.kind).toBe('challenge')
  })
})

describe('parseSignatureObject / parseExactObject / parseUptoObject — object-input cores', () => {
  it('parseSignatureObject reads a v2 onchain-proof object (no base64)', () => {
    const obj = { x402Version: 2, accepted: { scheme: 'onchain-proof', network: 'eip155:8453', asset: USDC }, payload: { nonce: 'n', txHash: '0xabc' } }
    const p = parseSignatureObject(obj)
    expect(p).not.toBeNull()
    expect(p!.payload.txHash).toBe('0xabc')
  })

  it('parseSignatureObject rejects an exact object (cross-scheme)', () => {
    const obj = { x402Version: 2, accepted: { scheme: 'exact', network: 'eip155:8453', asset: USDC }, payload: { signature: '0xsig', authorization: AUTH() } }
    expect(parseSignatureObject(obj)).toBeNull()
  })

  it('parseExactObject reads a v2 eip3009 object + a v1 flat object identically to the header parser', () => {
    const v2 = parseExactObject({ x402Version: 2, accepted: { scheme: 'exact', network: 'eip155:8453', asset: USDC }, payload: { signature: '0xsig', authorization: AUTH() } })
    expect(v2?.method).toBe('eip3009')
    const v1 = parseExactObject({ x402Version: 1, scheme: 'exact', network: 'base', payload: { signature: '0xsig', authorization: AUTH() } })
    expect(v1?.method).toBe('eip3009')
    expect(v1?.x402Version).toBe(1)
  })

  it('parseExactObject rejects an onchain-proof object (cross-scheme) + garbage', () => {
    expect(parseExactObject({ x402Version: 2, accepted: { scheme: 'onchain-proof', network: 'eip155:8453' }, payload: { nonce: 'n', txHash: '0xabc' } })).toBeNull()
    expect(parseExactObject(null)).toBeNull()
    expect(parseExactObject('nope')).toBeNull()
  })

  it('parseUptoObject reads an upto object (witness.facilitator) but rejects an exact permit2 object (no facilitator)', () => {
    const upto = parseUptoObject({ x402Version: 2, accepted: { scheme: 'upto', network: 'eip155:8453', asset: USDC }, payload: { signature: '0xsig', permit2Authorization: PA({ witness: { to: PAY_TO, facilitator: RELAYER_ADDR, validAfter: '0' } }) } })
    expect(upto?.method).toBe('permit2-upto')
    // An exact permit2 payload (no facilitator in the witness) must NOT match the upto core.
    expect(parseUptoObject({ x402Version: 2, accepted: { scheme: 'exact', network: 'eip155:8453', asset: USDC }, payload: { signature: '0xsig', permit2Authorization: PA() } })).toBeNull()
  })

  it('the object cores equal the base64 header parsers on the same value (round-trip parity)', async () => {
    // Build a v2 exact header, decode it, and assert parseExactObject(decoded) === parseExactPaymentHeader(header).
    const { parseExactPaymentHeader } = await import('../src/x402.js')
    const header = b64({ x402Version: 2, accepted: { scheme: 'exact', network: 'eip155:8453', asset: USDC }, payload: { signature: '0xsig', authorization: AUTH() } })
    expect(parseExactObject(decodeBase64Json(header))).toEqual(parseExactPaymentHeader(header))
  })
})

/**
 * The standard x402 `exact` rail on NEAR — the BUYER's NEP-366 SignedDelegateAction build + sign,
 * with NO network (the access-key nonce + block height are passed in, exactly as the driver pre-reads
 * them). Proves the round-trip shape, that the delegated action binds the trusted accept
 * (token contract / payTo / amount embedded in the Borsh), that the framed header parses back as
 * `method: 'near'`, ed25519 determinism (stable dedupe), and the input guards. NEAR exact is
 * facilitator-settled (no PipRail self-settle), so the gate-side forwarding lives in
 * test/server-near-exact.test.ts.
 */
import { describe, it, expect } from 'vitest'
import { KeyPair, KeyPairSigner } from 'near-api-js'
import { payExactNear } from '../../src/drivers/near/exact.js'
import { parseExactPaymentHeader } from '../../src/x402.js'
import { UnsupportedSchemeError } from '../../src/errors.js'
import type { X402ExactAcceptEntry } from '../../src/x402.js'

const USDC = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1' // Circle native USDC on NEAR
const SENDER = 'alice.near'
const PAY_TO = 'merchant.near'
const BLOCK = 130_000_000n
const NONCE = 5n

const newSigner = () => new KeyPairSigner(KeyPair.fromRandom('ed25519'))

function makeAccept(
  over: Partial<{ asset: string; payTo: string; amount: string; maxTimeoutSeconds: number }> = {}
): X402ExactAcceptEntry {
  return {
    scheme: 'exact',
    network: 'near:mainnet',
    amount: over.amount ?? '1000000',
    asset: over.asset ?? USDC,
    payTo: over.payTo ?? PAY_TO,
    maxTimeoutSeconds: over.maxTimeoutSeconds ?? 60,
    extra: { assetTransferMethod: 'near', feePayer: 'uvd-facilitator.near', decimals: 6 },
  }
}

describe('NEAR exact — buyer build (payExactNear)', () => {
  it('builds a base64 SignedDelegateAction binding the ft_transfer to the trusted accept', async () => {
    const { payload, payerFrom, nonce } = await payExactNear({
      signer: newSigner(),
      senderId: SENDER,
      blockHeight: BLOCK,
      accessKeyNonce: NONCE,
      accept: makeAccept(),
    })
    expect(payerFrom).toBe(SENDER)
    // Dedupe id = account + the delegate nonce (accessKeyNonce + 1); single-use on-chain.
    expect(nonce).toBe(`${SENDER}:${(NONCE + 1n).toString()}`)
    expect(typeof payload.signedDelegateAction).toBe('string')

    // The Borsh encoding embeds the raw UTF-8 of the method name, the JSON args, and the account ids
    // contiguously (each is a length-prefixed field), so we can assert the binding version-independently.
    const text = Buffer.from(payload.signedDelegateAction, 'base64').toString('latin1')
    expect(text.length).toBeGreaterThan(100)
    expect(text).toContain('ft_transfer')
    expect(text).toContain('{"receiver_id":"merchant.near","amount":"1000000"}') // payTo + exact amount
    expect(text).toContain(SENDER) // delegate sender_id
    expect(text).toContain(USDC) // delegate receiver_id = the NEP-141 token contract
  })

  it('frames into a PAYMENT-SIGNATURE that parses back as method:near', async () => {
    const accept = makeAccept()
    const { payload } = await payExactNear({
      signer: newSigner(),
      senderId: SENDER,
      blockHeight: BLOCK,
      accessKeyNonce: NONCE,
      accept,
    })
    const header = Buffer.from(
      JSON.stringify({
        x402Version: 2,
        accepted: { scheme: 'exact', network: accept.network, asset: accept.asset },
        payload,
      })
    ).toString('base64')
    const parsed = parseExactPaymentHeader(header)
    expect(parsed?.method).toBe('near')
    expect((parsed?.payload as { signedDelegateAction: string }).signedDelegateAction).toBe(
      payload.signedDelegateAction
    )
  })

  it('is deterministic (ed25519): same key + inputs → identical signed action (stable re-present)', async () => {
    const kp = KeyPair.fromRandom('ed25519')
    const a = await payExactNear({
      signer: new KeyPairSigner(kp),
      senderId: SENDER,
      blockHeight: BLOCK,
      accessKeyNonce: NONCE,
      accept: makeAccept(),
    })
    const b = await payExactNear({
      signer: new KeyPairSigner(kp),
      senderId: SENDER,
      blockHeight: BLOCK,
      accessKeyNonce: NONCE,
      accept: makeAccept(),
    })
    expect(a.payload.signedDelegateAction).toBe(b.payload.signedDelegateAction)
  })

  it('rejects native NEAR (the scheme is NEP-141-only)', async () => {
    await expect(
      payExactNear({ signer: newSigner(), senderId: SENDER, blockHeight: BLOCK, accessKeyNonce: NONCE, accept: makeAccept({ asset: 'native' }) })
    ).rejects.toBeInstanceOf(UnsupportedSchemeError)
  })

  it('rejects an EVM-shaped payTo', async () => {
    await expect(
      payExactNear({ signer: newSigner(), senderId: SENDER, blockHeight: BLOCK, accessKeyNonce: NONCE, accept: makeAccept({ payTo: '0xabc123' }) })
    ).rejects.toBeInstanceOf(UnsupportedSchemeError)
  })

  it('rejects a non-positive maxTimeoutSeconds', async () => {
    await expect(
      payExactNear({ signer: newSigner(), senderId: SENDER, blockHeight: BLOCK, accessKeyNonce: NONCE, accept: makeAccept({ maxTimeoutSeconds: 0 }) })
    ).rejects.toBeInstanceOf(UnsupportedSchemeError)
  })

  it('sets max_block_height = blockHeight + ceil(maxTimeoutSeconds) (deterministic timeout mapping)', async () => {
    // 90s ⇒ +90 blocks (estimatedBlockSeconds = 1). Two builds at different heights must differ — i.e.
    // the height is actually folded into the signed bytes (else the signature wouldn't change).
    const lo = await payExactNear({ signer: newSigner(), senderId: SENDER, blockHeight: 1000n, accessKeyNonce: NONCE, accept: makeAccept({ maxTimeoutSeconds: 90 }) })
    const hi = await payExactNear({ signer: newSigner(), senderId: SENDER, blockHeight: 2000n, accessKeyNonce: NONCE, accept: makeAccept({ maxTimeoutSeconds: 90 }) })
    expect(lo.payload.signedDelegateAction).not.toBe(hi.payload.signedDelegateAction)
  })
})

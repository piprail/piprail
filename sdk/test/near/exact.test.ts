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
import { KeyPair, KeyPairSigner, actions, buildDelegateAction, encodeSignedDelegate } from 'near-api-js'
import {
  payExactNear,
  verifyExactNear,
  verifyAndSettleExactNear,
  type NearRelayClient,
} from '../../src/drivers/near/exact.js'
import { parseExactPaymentHeader } from '../../src/x402.js'
import { SettlementError, UnsupportedSchemeError } from '../../src/errors.js'
import type { ExactNearPaymentPayload, X402ExactAcceptEntry } from '../../src/x402.js'

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

/* ───────────────────────── SELLER SIDE (self-settle verify + relay) ───────────────────────── */

const TGAS = (n: number) => BigInt(n) * 1_000_000_000_000n

/** Build a real (near-api-js-signed) SignedDelegateAction payload with overridable fields, so each
 *  verify guard can be exercised against a genuine borsh-encoded delegate (not a hand-faked one). */
async function buildDelegatePayload(
  over: {
    token?: string; payTo?: string; amount?: string; sender?: string
    deposit?: bigint; gas?: bigint; maxBlockHeight?: bigint; method?: string; twoActions?: boolean
  } = {}
): Promise<ExactNearPaymentPayload> {
  const signer = newSigner()
  const action = actions.functionCall(
    over.method ?? 'ft_transfer',
    { receiver_id: over.payTo ?? PAY_TO, amount: over.amount ?? '1000000' },
    over.gas ?? TGAS(30),
    over.deposit ?? 1n
  )
  const da = buildDelegateAction({
    senderId: over.sender ?? SENDER,
    receiverId: over.token ?? USDC,
    actions: over.twoActions ? [action, action] : [action],
    nonce: 5n,
    maxBlockHeight: over.maxBlockHeight ?? 1000n,
    publicKey: await signer.getPublicKey(),
  })
  const { signedDelegate } = await signer.signDelegateAction(da)
  return { signedDelegateAction: Buffer.from(encodeSignedDelegate(signedDelegate)).toString('base64') }
}

describe('NEAR exact — seller verify (verifyExactNear, re-derives from trusted accept)', () => {
  const accept = makeAccept() // payTo=merchant.near, asset=USDC, amount=1000000, near:mainnet

  it('accepts a well-formed delegate bound to the trusted accept', async () => {
    const r = verifyExactNear(await buildDelegatePayload(), accept, 500n) // height 500 < maxBlock 1000 → live
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.senderId).toBe(SENDER)
  })

  it('DRAIN GUARD: rejects a delegate whose attached deposit ≠ 1 yocto', async () => {
    const r = verifyExactNear(await buildDelegatePayload({ deposit: 2n }), accept, 500n)
    expect(r).toMatchObject({ ok: false, error: 'signature_invalid' })
    if (!r.ok) expect(r.detail).toMatch(/deposit|drain/i)
  })

  it('DRAIN GUARD: rejects a delegate whose gas exceeds the 300 TGas cap', async () => {
    const r = verifyExactNear(await buildDelegatePayload({ gas: TGAS(400) }), accept, 500n)
    expect(r).toMatchObject({ ok: false, error: 'signature_invalid' })
    if (!r.ok) expect(r.detail).toMatch(/gas|drain/i)
  })

  it('rejects a wrong recipient (re-derived payTo, not the client echo)', async () => {
    const r = verifyExactNear(await buildDelegatePayload({ payTo: 'attacker.near' }), accept, 500n)
    expect(r).toMatchObject({ ok: false, error: 'wrong_recipient' })
  })

  it('rejects an amount below the required', async () => {
    const r = verifyExactNear(await buildDelegatePayload({ amount: '500000' }), accept, 500n)
    expect(r).toMatchObject({ ok: false, error: 'amount_too_low' })
  })

  it('rejects a transfer on the wrong token contract', async () => {
    const r = verifyExactNear(await buildDelegatePayload({ token: 'usdt.tether-token.near' }), accept, 500n)
    expect(r).toMatchObject({ ok: false, error: 'transfer_not_found' })
  })

  it('rejects a non-ft_transfer method and a multi-action delegate', async () => {
    expect(verifyExactNear(await buildDelegatePayload({ method: 'storage_deposit' }), accept, 500n)).toMatchObject({ ok: false, error: 'transfer_not_found' })
    expect(verifyExactNear(await buildDelegatePayload({ twoActions: true }), accept, 500n)).toMatchObject({ ok: false, error: 'transfer_not_found' })
  })

  it('rejects an expired delegate (max_block_height ≤ current), but allows it when height is unknown', async () => {
    const payload = await buildDelegatePayload({ maxBlockHeight: 1000n })
    expect(verifyExactNear(payload, accept, 1000n)).toMatchObject({ ok: false, error: 'payment_expired' }) // expired
    expect(verifyExactNear(payload, accept, 999n).ok).toBe(true) // still live
    expect(verifyExactNear(payload, accept, null).ok).toBe(true) // height unreadable → skip pre-check
  })

  it('rejects unparseable / non-string payloads', async () => {
    expect(verifyExactNear({ signedDelegateAction: 'not-valid-borsh!!' }, accept, 500n)).toMatchObject({ ok: false, error: 'signature_invalid' })
    expect(verifyExactNear({ signedDelegateAction: 123 as unknown as string }, accept, 500n)).toMatchObject({ ok: false, error: 'signature_invalid' })
  })

  it('rejects a native rail (NEP-141 only)', async () => {
    const r = verifyExactNear(await buildDelegatePayload(), { ...accept, asset: 'native' }, 500n)
    expect(r).toMatchObject({ ok: false, error: 'transfer_not_found' })
  })
})

describe('NEAR exact — seller settle (verifyAndSettleExactNear via mock relay client)', () => {
  const accept = makeAccept()
  const mockClient = (over: Partial<NearRelayClient> = {}): NearRelayClient => ({
    currentBlockHeight: over.currentBlockHeight ?? (async () => 500n),
    relay: over.relay ?? (async () => ({ txHash: 'RELAY_TX', innerSuccess: true })),
  })

  it('verifies + relays a valid delegate → paid receipt with the relay tx', async () => {
    const r = await verifyAndSettleExactNear({ client: mockClient(), payload: await buildDelegatePayload(), accept })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.receipt).toMatchObject({ scheme: 'exact', transaction: 'RELAY_TX', asset: USDC, amount: '1000000', payer: SENDER, payTo: PAY_TO })
    }
  })

  it('does not relay (and 402s) when verification fails — the drain-guard delegate never reaches the relayer', async () => {
    let relayed = false
    const r = await verifyAndSettleExactNear({
      client: mockClient({ relay: async () => { relayed = true; return { txHash: 'X', innerSuccess: true } } }),
      payload: await buildDelegatePayload({ gas: TGAS(400) }),
      accept,
    })
    expect(r).toMatchObject({ ok: false, error: 'signature_invalid' })
    expect(relayed).toBe(false)
  })

  it('maps a used-nonce relay error to tx_already_used (client-fixable, not a 5xx)', async () => {
    const r = await verifyAndSettleExactNear({
      client: mockClient({ relay: async () => { throw new Error('Invalid delegate nonce (DelegateActionInvalidNonce)') } }),
      payload: await buildDelegatePayload(), accept,
    })
    expect(r).toMatchObject({ ok: false, error: 'tx_already_used' })
  })

  it('returns tx_reverted when the inner ft_transfer receipt did not succeed', async () => {
    const r = await verifyAndSettleExactNear({
      client: mockClient({ relay: async () => ({ txHash: 'T', innerSuccess: false }) }),
      payload: await buildDelegatePayload(), accept,
    })
    expect(r).toMatchObject({ ok: false, error: 'tx_reverted' })
  })

  it('THROWS SettlementError on a server-side relay failure (valid delegate, relayer down)', async () => {
    await expect(
      verifyAndSettleExactNear({
        client: mockClient({ relay: async () => { throw new Error('RPC connection refused') } }),
        payload: await buildDelegatePayload(), accept,
      })
    ).rejects.toBeInstanceOf(SettlementError)
  })
})

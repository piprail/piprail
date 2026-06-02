import { describe, it, expect } from 'vitest'
import { parseUnits } from 'viem'
import { createPaymentGate, type RequirePaymentOptions } from '../src/server.js'
import { buildSignatureHeader } from '../src/x402.js'

const PAY_TO = '0x1111111111111111111111111111111111111111' as const
const TOKEN = '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d' as const

function baseOptions(over: Partial<RequirePaymentOptions> = {}): RequirePaymentOptions {
  return {
    chain: { id: 56, rpcUrl: 'https://bsc.example/rpc' },
    token: { address: TOKEN, decimals: 18, symbol: 'USDC' },
    amount: '0.05',
    payTo: PAY_TO,
    ...over,
  }
}

describe('createPaymentGate — challenge issuance', () => {
  it('builds an x402 challenge with the right amount, asset, and chain', async () => {
    const gate = createPaymentGate(baseOptions())
    const { challenge } = await gate.challenge('https://api.example.com/report')

    const accept = challenge.accepts[0]!
    expect(challenge.x402Version).toBe(2)
    expect(accept.network).toBe('eip155:56')
    expect(accept.asset).toBe(TOKEN)
    expect(accept.payTo).toBe(PAY_TO)
    expect(accept.amount).toBe(parseUnits('0.05', 18).toString())
    expect(accept.extra.symbol).toBe('USDC')
    expect(accept.extra.amountFormatted).toBe('0.05')
    expect(challenge.resource.url).toBe('https://api.example.com/report')
  })

  it('mints a fresh nonce per challenge', async () => {
    const gate = createPaymentGate(baseOptions())
    const a = (await gate.challenge()).challenge.accepts[0]!.extra.nonce
    const b = (await gate.challenge()).challenge.accepts[0]!.extra.nonce
    expect(a).not.toBe(b)
  })

  it('supports native payment as the token', async () => {
    const gate = createPaymentGate(
      baseOptions({ token: 'native', amount: '0.01' })
    )
    const accept = (await gate.challenge()).challenge.accepts[0]!
    expect(accept.asset).toBe('native')
    // bare { id, rpcUrl } chains default to 18-decimal native
    expect(accept.amount).toBe(parseUnits('0.01', 18).toString())
  })

  it('a built-in chain name + symbol token resolves with zero addresses pasted', async () => {
    // chain: 'base', token: 'USDC' → the SDK fills in the 6-decimal USDC contract.
    const gate = createPaymentGate({ chain: 'base', token: 'USDC', amount: '0.05', payTo: PAY_TO })
    const accept = (await gate.challenge()).challenge.accepts[0]!
    expect(accept.network).toBe('eip155:8453')
    expect(accept.asset).toBe('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')
    expect(accept.extra.symbol).toBe('USDC')
    expect(accept.amount).toBe(parseUnits('0.05', 6).toString())
  })

  it('resolves a token symbol against the chosen chain (USDT on bnb, 18 decimals)', async () => {
    const gate = createPaymentGate({ chain: 'bnb', token: 'USDT', amount: '1', payTo: PAY_TO })
    const accept = (await gate.challenge()).challenge.accepts[0]!
    expect(accept.asset).toBe('0x55d398326f99059fF775485246999027B3197955')
    expect(accept.amount).toBe(parseUnits('1', 18).toString())
  })

  it('total control: a custom { id, rpcUrl } chain + custom { address, decimals } token', async () => {
    // Aurora (1313161554) isn't built in, and the token is passed by address —
    // no preset needed for either. This is the "any chain, any token" path.
    const gate = createPaymentGate({
      chain: { id: 1313161554, rpcUrl: 'https://mainnet.aurora.dev' },
      token: { address: '0xB12BFcA5A55806AaF64E99521918A4bf0fC40802', decimals: 6, symbol: 'USDC' },
      amount: '0.05',
      payTo: PAY_TO,
    })
    const accept = (await gate.challenge()).challenge.accepts[0]!
    expect(accept.network).toBe('eip155:1313161554')
    expect(accept.asset).toBe('0xB12BFcA5A55806AaF64E99521918A4bf0fC40802')
    expect(accept.extra.decimals).toBe(6)
    expect(accept.extra.symbol).toBe('USDC')
    expect(accept.amount).toBe(parseUnits('0.05', 6).toString())
  })

  it('rejects an unknown token symbol on an exotic chain (on first use)', async () => {
    // Aurora (1313161554) isn't a built-in preset → 'USDC' can't resolve by symbol.
    // Resolution is lazy now, so the error surfaces on the first challenge().
    const gate = createPaymentGate({
      chain: { id: 1313161554, rpcUrl: 'https://mainnet.aurora.dev' },
      token: 'USDC',
      amount: '1',
      payTo: PAY_TO,
    })
    await expect(gate.challenge()).rejects.toThrow(/isn't built in/)
  })
})

describe('createPaymentGate — verify branches that need no RPC', () => {
  it('returns a challenge when no payment-signature is present', async () => {
    const gate = createPaymentGate(baseOptions())
    const res = await gate.verify(undefined)
    expect(res.kind).toBe('challenge')
    if (res.kind === 'challenge') expect(res.statusCode).toBe(402)
  })

  it('returns a challenge when the signature is unparseable', async () => {
    const gate = createPaymentGate(baseOptions())
    const res = await gate.verify('garbage-not-base64-json')
    expect(res.kind).toBe('challenge')
  })

  it('returns a challenge (never throws) for a legacy proof with no `accepted`', async () => {
    // parseSignatureHeader stays lenient for transitional callers and parses a
    // top-level-`scheme` proof carrying no `accepted`. verify() must NOT then
    // dereference the missing `accepted` (a TypeError → HTTP 500 on a hostile
    // request); it re-issues a fresh 402 instead.
    const gate = createPaymentGate(baseOptions())
    const legacy = {
      x402Version: 2,
      scheme: 'onchain-proof',
      network: 'eip155:56',
      payload: { nonce: 'n', txHash: `0x${'a'.repeat(64)}` },
    }
    const res = await gate.verify(buildSignatureHeader(legacy as never))
    expect(res.kind).toBe('challenge')
  })

  it('rejects an already-redeemed tx hash before touching the chain', async () => {
    const txHash = `0x${'a'.repeat(64)}` as `0x${string}`
    // Pre-seed the replay store so verify short-circuits to "invalid".
    const gate = createPaymentGate(
      baseOptions({ isUsed: () => true, markUsed: () => {} })
    )
    const accepted = (await gate.challenge()).challenge.accepts[0]!
    const sigHeader = buildSignatureHeader({
      x402Version: 2,
      accepted,
      payload: { nonce: accepted.extra.nonce, txHash },
    })
    const res = await gate.verify(sigHeader)
    expect(res).toMatchObject({ kind: 'invalid', error: 'tx_already_used' })
  })
})

/**
 * x402 v2 envelope conformance — locks the wire field names so a regression to
 * the pre-v2 shape (or a drift away from spec) fails loudly. The settlement
 * SCHEME stays our own `onchain-proof`; only the ENVELOPE is asserted here.
 * Reference: github.com/coinbase/x402 specs/x402-specification-v2.md + transports-v2/http.md.
 */
import { describe, it, expect } from 'vitest'
import { createPaymentGate } from '../src/server.js'
import {
  buildSignatureHeader,
  parseSignatureHeader,
  buildReceiptHeader,
  parseReceipt,
  HEADER_REQUIRED,
  HEADER_SIGNATURE,
  HEADER_RESPONSE,
  type X402AcceptEntry,
  type X402Receipt,
} from '../src/x402.js'

const PAY_TO = '0x1111111111111111111111111111111111111111'

describe('x402 v2 envelope conformance', () => {
  it('uses the lowercase v2 header names (no X- prefix)', () => {
    expect(HEADER_REQUIRED).toBe('payment-required')
    expect(HEADER_SIGNATURE).toBe('payment-signature')
    expect(HEADER_RESPONSE).toBe('payment-response')
  })

  it('challenge + PaymentRequirements carry the v2 field names', async () => {
    const gate = createPaymentGate({
      chain: { id: 56, rpcUrl: 'https://bsc.example/rpc' },
      token: { address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', decimals: 18, symbol: 'USDC' },
      amount: '0.05',
      payTo: PAY_TO,
    })
    const { challenge, requiredHeader } = await gate.challenge('https://api.example.com/x')
    expect(challenge.x402Version).toBe(2)
    expect(typeof requiredHeader).toBe('string') // base64 PAYMENT-REQUIRED body
    expect(challenge.resource.url).toBe('https://api.example.com/x')

    const a = challenge.accepts[0]!
    for (const k of ['scheme', 'network', 'amount', 'asset', 'payTo', 'maxTimeoutSeconds', 'extra'] as const) {
      expect(a).toHaveProperty(k)
    }
    expect(a.scheme).toBe('onchain-proof')
    // v2 names the atomic amount `amount`; v1 used `maxAmountRequired`.
    expect('maxAmountRequired' in a).toBe(false)
    expect(a.amount).toBe('50000000000000000')
  })

  it('PaymentPayload carries `accepted` (v2), round-trips, no legacy top-level scheme/network', () => {
    const accepted: X402AcceptEntry = {
      scheme: 'onchain-proof',
      network: 'eip155:56',
      amount: '1',
      asset: 'native',
      payTo: PAY_TO,
      maxTimeoutSeconds: 600,
      extra: { nonce: 'n', decimals: 18, minConfirmations: 1, amountFormatted: '0.000000000000000001' },
    }
    const header = buildSignatureHeader({
      x402Version: 2,
      accepted,
      payload: { nonce: 'n', txHash: `0x${'a'.repeat(64)}` },
    })
    const parsed = parseSignatureHeader(header)
    expect(parsed).not.toBeNull()
    expect(parsed!.accepted.scheme).toBe('onchain-proof')
    expect(parsed!.accepted.network).toBe('eip155:56')
    expect(parsed!.payload.txHash).toBe(`0x${'a'.repeat(64)}`)
    const obj = parsed as unknown as Record<string, unknown>
    expect('scheme' in obj).toBe(false)
    expect('network' in obj).toBe(false)
  })

  it('SettlementResponse uses `success` + `transaction` (v2), not `txHash`', () => {
    const receipt: X402Receipt = {
      scheme: 'onchain-proof',
      success: true,
      network: 'eip155:56',
      transaction: `0x${'b'.repeat(64)}`,
      asset: 'native',
      amount: '1000',
      payer: '0x2222222222222222222222222222222222222222',
      payTo: PAY_TO,
      verifiedAt: '2026-06-01T00:00:00.000Z',
    }
    const res = new Response(null, { status: 200, headers: { [HEADER_RESPONSE]: buildReceiptHeader(receipt) } })
    const parsed = parseReceipt(res)
    expect(parsed).toEqual(receipt)
    expect(parsed!.success).toBe(true)
    expect(parsed!.transaction).toBe(`0x${'b'.repeat(64)}`)
    expect('txHash' in (parsed as unknown as Record<string, unknown>)).toBe(false)
  })

  it('parses a scheme:"exact" SettlementResponse (the standard rail also issues receipts)', () => {
    const receipt: X402Receipt = {
      scheme: 'exact',
      success: true,
      network: 'eip155:8453',
      transaction: `0x${'e'.repeat(64)}`,
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      amount: '50000',
      payer: '0x2222222222222222222222222222222222222222',
      payTo: PAY_TO,
      verifiedAt: '2026-06-09T00:00:00.000Z',
    }
    const res = new Response(null, { status: 200, headers: { [HEADER_RESPONSE]: buildReceiptHeader(receipt) } })
    const parsed = parseReceipt(res)
    expect(parsed).not.toBeNull()
    expect(parsed!.scheme).toBe('exact')
    expect(parsed!.transaction).toBe(`0x${'e'.repeat(64)}`)
  })

  it('parses a scheme:"upto" SettlementResponse — incl. a $0 metered settle (amount:"0", transaction:"")', () => {
    // A non-zero metered settle.
    const paid: X402Receipt = {
      scheme: 'upto',
      success: true,
      network: 'eip155:8453',
      transaction: `0x${'d'.repeat(64)}`,
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      amount: '1858', // the metered ACTUAL, ≤ the signed MAX
      payer: '0x2222222222222222222222222222222222222222',
      payTo: PAY_TO,
      verifiedAt: '2026-06-20T00:00:00.000Z',
    }
    const paidRes = new Response(null, { status: 200, headers: { [HEADER_RESPONSE]: buildReceiptHeader(paid) } })
    const parsedPaid = parseReceipt(paidRes)
    expect(parsedPaid).not.toBeNull()
    expect(parsedPaid!.scheme).toBe('upto')
    expect(parsedPaid!.amount).toBe('1858')
    // A $0 metered settle — transaction is the empty STRING (spec §5.3), and it MUST still validate.
    const zero: X402Receipt = { ...paid, amount: '0', transaction: '' }
    const zeroRes = new Response(null, { status: 200, headers: { [HEADER_RESPONSE]: buildReceiptHeader(zero) } })
    expect(parseReceipt(zeroRes)).toEqual(zero)
  })

  it('rejects a receipt that has neither `transaction` nor legacy `txHash`', () => {
    const bad = {
      scheme: 'onchain-proof',
      success: true,
      network: 'eip155:56',
      payer: '0x2222222222222222222222222222222222222222',
      asset: 'native',
      amount: '1',
    }
    const res = new Response(null, { status: 200, headers: { [HEADER_RESPONSE]: buildReceiptHeader(bad as never) } })
    expect(parseReceipt(res)).toBeNull()
  })
})

describe('x402 v2 conformance — a rejected proof is a full PaymentRequired (so a standard client can retry)', () => {
  // Force a rejection with no RPC: a pre-seeded replay store → tx_already_used.
  const rejectingGate = () =>
    createPaymentGate({
      chain: { id: 56, rpcUrl: 'https://bsc.example/rpc' },
      token: { address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', decimals: 18, symbol: 'USDC' },
      amount: '0.05',
      payTo: PAY_TO,
      isUsed: () => true,
      markUsed: () => {},
    })

  it('the invalid result carries a conformant re-challenge, not a bare {status:invalid}', async () => {
    const gate = rejectingGate()
    const accepted = (await gate.challenge()).challenge.accepts[0]!
    const header = buildSignatureHeader({
      x402Version: 2,
      // accepted is the onchain-proof rail (this gate has no exact rail)
      accepted: accepted as never,
      payload: { nonce: 'n', txHash: `0x${'a'.repeat(64)}` },
    })
    const res = await gate.verify(header)
    expect(res.kind).toBe('invalid')
    if (res.kind !== 'invalid') return

    const body = res.challenge
    // A standard x402 client receiving this 402 can re-pay: it's a real PaymentRequired.
    expect(body.x402Version).toBe(2)
    expect(Array.isArray(body.accepts)).toBe(true)
    expect(body.accepts.length).toBeGreaterThanOrEqual(1)
    expect(body.resource).toBeDefined()
    // Human reason in `error`; machine code in extensions.piprail.
    expect(typeof body.error).toBe('string')
    expect(body.error).toContain('tx_already_used')
    expect(body.extensions).toMatchObject({ piprail: { code: 'tx_already_used' } })
    // The PAYMENT-REQUIRED header is set (base64 body).
    expect(typeof res.requiredHeader).toBe('string')
    // It is NOT the legacy non-conformant shape.
    expect((body as unknown as Record<string, unknown>).status).toBeUndefined()
  })

  it('a fresh challenge omits `error` (no JSON null on the wire)', async () => {
    const gate = createPaymentGate({
      chain: { id: 56, rpcUrl: 'https://bsc.example/rpc' },
      token: { address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', decimals: 18, symbol: 'USDC' },
      amount: '0.05',
      payTo: PAY_TO,
    })
    const { challenge } = await gate.challenge('https://api/x')
    expect('error' in challenge).toBe(false)
  })
})

describe('gate discovery option — extensions.bazaar (opt-in, x402scan-listable)', () => {
  const mkGate = (discovery?: boolean | object) =>
    createPaymentGate({
      chain: { id: 8453, rpcUrl: 'https://base.example/rpc' },
      token: { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6, symbol: 'USDC' },
      amount: '0.05',
      payTo: PAY_TO,
      ...(discovery !== undefined ? { discovery } : {}),
    })

  it('omitting discovery → NO extensions.bazaar (byte-identical default)', async () => {
    const { challenge } = await mkGate().challenge('https://api/x')
    expect((challenge.extensions as Record<string, unknown> | undefined)?.bazaar).toBeUndefined()
  })

  it('discovery:true → emits a no-input GET bazaar block in BOTH the body and the decoded header', async () => {
    const { challenge, requiredHeader } = await mkGate(true).challenge('https://api/x')
    const bazaar = (challenge.extensions as { bazaar?: { info?: { input?: unknown } } }).bazaar
    expect(bazaar?.info?.input).toEqual({ type: 'http', method: 'GET', queryParams: {} })
    const decoded = JSON.parse(Buffer.from(requiredHeader, 'base64').toString('utf8'))
    expect(decoded.extensions.bazaar.info.input.method).toBe('GET') // x402scan reads the header
  })

  it('a discovery descriptor is reflected in the bazaar block', async () => {
    const { challenge } = await mkGate({ method: 'POST', queryParams: { page: { type: 'integer' } } }).challenge('https://api/x')
    const input = (challenge.extensions as { bazaar: { info: { input: { method: string; queryParams: unknown } } } }).bazaar.info.input
    expect(input.method).toBe('POST')
    expect(input.queryParams).toEqual({ page: { type: 'integer' } })
  })
})

describe('x402 self-describing 402 — extensions.piprail (discoverability Phase 5, default-ON)', () => {
  const mk = (extra: object = {}) =>
    createPaymentGate({
      chain: { id: 8453, rpcUrl: 'https://base.example/rpc' },
      token: { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6, symbol: 'USDC' },
      amount: '0.05',
      payTo: PAY_TO,
      ...extra,
    })

  it('default-ON: a fresh challenge carries extensions.piprail (identity + pay[] + sdk install)', async () => {
    const { challenge } = await mk().challenge('https://api/x')
    const pr = (challenge.extensions as { piprail?: Record<string, any> } | undefined)?.piprail
    expect(pr).toBeDefined()
    expect(pr!.name).toBe('PipRail')
    expect(pr!.protocol).toBe('x402')
    expect(Array.isArray(pr!.pay)).toBe(true)
    expect(pr!.pay.length).toBeGreaterThanOrEqual(1)
    expect(pr!.pay[0].scheme).toBe('onchain-proof')
    expect(pr!.sdk.install).toBe('npm i @piprail/sdk')
    expect(pr!.discovery).toEqual({ openapi: '/openapi.json', wellKnown: '/.well-known/x402' })
    // the :179 invariant STILL holds — a fresh challenge omits `error` with self-describe on
    expect('error' in challenge).toBe(false)
  })

  it('selfDescribe:false → no extensions.piprail, and no extensions at all without discovery (byte-identical)', async () => {
    const { challenge } = await mk({ selfDescribe: false }).challenge('https://api/x')
    expect((challenge.extensions as { piprail?: unknown } | undefined)?.piprail).toBeUndefined()
    expect(challenge.extensions).toBeUndefined()
  })

  it('the pay path is byte-identical with the block on vs off (accepts unchanged)', async () => {
    const on = (await mk().challenge('https://api/x')).challenge.accepts[0]!
    const off = (await mk({ selfDescribe: false }).challenge('https://api/x')).challenge.accepts[0]!
    for (const k of ['scheme', 'network', 'asset', 'payTo', 'amount'] as const) {
      expect((on as unknown as Record<string, unknown>)[k]).toEqual((off as unknown as Record<string, unknown>)[k])
    }
  })

  it('MERGE-ORDER: a rejection keeps {code,detail} (wins) AND the self-describe siblings AND bazaar', async () => {
    const gate = mk({ discovery: true, isUsed: () => true, markUsed: () => {} })
    const accepted = (await gate.challenge()).challenge.accepts[0]!
    const header = buildSignatureHeader({
      x402Version: 2,
      accepted: accepted as never,
      payload: { nonce: 'n', txHash: `0x${'a'.repeat(64)}` },
    })
    const res = await gate.verify(header)
    expect(res.kind).toBe('invalid')
    if (res.kind !== 'invalid') return
    const ext = res.challenge.extensions as { piprail?: Record<string, any>; bazaar?: unknown }
    expect(ext.piprail!.code).toBe('tx_already_used') // rejection reason survived (client.ts reads this)
    expect(ext.piprail!.name).toBe('PipRail') // self-describe sibling present (not clobbered)
    expect(ext.bazaar).toBeDefined() // the discovery block survived the merge
    expect(res.challenge.error).toContain('tx_already_used')
  })

  it('a fresh single-rail header has NO extensions (PAYMENT-REQUIRED byte-identical default)', async () => {
    const { requiredHeader } = await mk().challenge('https://api/x')
    const decoded = JSON.parse(Buffer.from(requiredHeader, 'base64').toString('utf8'))
    expect('extensions' in decoded).toBe(false) // self-describe is body-only; header unchanged
  })

  it('the self-describe block is BODY-only — the header stays slim on a many-rail gate', async () => {
    const ids = [8453, 56, 42161, 10, 137, 43114]
    const gate = createPaymentGate({
      accept: ids.map((id) => ({
        chain: { id, rpcUrl: `https://rpc-${id}.example/rpc` },
        token: { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6, symbol: 'USDC' },
        amount: '0.05',
      })),
      payTo: PAY_TO,
    })
    const { challenge, requiredHeader } = await gate.challenge('https://api/x')
    // BODY carries the full self-describe block (one rail per chain)
    const bodyPr = (challenge.extensions as { piprail: { name: string; pay: unknown[] } }).piprail
    expect(bodyPr.name).toBe('PipRail')
    expect(bodyPr.pay.length).toBe(6)
    // HEADER carries the accepts[] (the pay path) but NOT the self-describe block, so it can't
    // blow past proxy/CDN header caps (~8KB). This is the P1 regression guard.
    const decoded = JSON.parse(Buffer.from(requiredHeader, 'base64').toString('utf8'))
    expect(decoded.accepts.length).toBe(6)
    expect(decoded.extensions?.piprail).toBeUndefined()
    expect(requiredHeader.length).toBeLessThan(8192)
  })

  it('selfDescribe:false rejection keeps the machine code, with no self-describe block', async () => {
    const gate = mk({ selfDescribe: false, isUsed: () => true, markUsed: () => {} })
    const accepted = (await gate.challenge()).challenge.accepts[0]!
    const header = buildSignatureHeader({
      x402Version: 2,
      accepted: accepted as never,
      payload: { nonce: 'n', txHash: `0x${'a'.repeat(64)}` },
    })
    const res = await gate.verify(header)
    expect(res.kind).toBe('invalid')
    if (res.kind !== 'invalid') return
    const ext = res.challenge.extensions as { piprail?: Record<string, unknown> }
    expect(ext.piprail!.code).toBe('tx_already_used')
    expect(ext.piprail!.name).toBeUndefined() // no self-describe block when opted out
  })

  it('no `endpoint` block by default (no description/mimeType/descriptor → byte-identical)', async () => {
    const { challenge } = await mk().challenge('https://api/x')
    const pr = (challenge.extensions as { piprail?: Record<string, any> }).piprail
    expect(pr).toBeDefined()
    expect('endpoint' in pr!).toBe(false)
    expect(challenge.resource.mimeType).toBeUndefined()
  })

  it('describes what the endpoint DOES: summary + mimeType + input/output schema (agent-readability)', async () => {
    const gate = mk({
      description: 'Current USD price for any crypto ticker',
      mimeType: 'application/json',
      discovery: {
        method: 'GET',
        queryParams: { symbol: { type: 'string' } },
        output: { type: 'json', example: { symbol: 'ETH', usd: 3247.18 } },
      },
    })
    const { challenge } = await gate.challenge('https://api/price')
    // v2 root resource carries the human description + content-type
    expect(challenge.resource).toMatchObject({ description: 'Current USD price for any crypto ticker', mimeType: 'application/json' })
    // and the self-describe block tells an agent the purpose, inputs, and an example output
    const ep = (challenge.extensions as { piprail: { endpoint: Record<string, any> } }).piprail.endpoint
    expect(ep).toMatchObject({
      summary: 'Current USD price for any crypto ticker',
      method: 'GET',
      mimeType: 'application/json',
      input: { symbol: { type: 'string' } },
      output: { type: 'json', example: { symbol: 'ETH', usd: 3247.18 } },
    })
    // the index-facing bazaar block is populated from the SAME descriptor
    const bazaar = (challenge.extensions as { bazaar: { info: { input: { queryParams: unknown } } } }).bazaar
    expect(bazaar.info.input.queryParams).toEqual({ symbol: { type: 'string' } })
  })

  it('a bare `description` (no descriptor) still yields a summary-only endpoint block', async () => {
    const { challenge } = await mk({ description: 'Weather by lat/lon' }).challenge('https://api/w')
    const pr = (challenge.extensions as { piprail: { endpoint?: Record<string, any> } }).piprail
    expect(pr.endpoint).toEqual({ summary: 'Weather by lat/lon' })
  })
})

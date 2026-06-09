// PipRail LIVE x402 endpoint — a real "402 Payment Required" resource on Base
// mainnet, built with @piprail/sdk (the exact same package published to npm).
//
// Dual-rail, so ANY x402 client can pay it:
//   • onchain-proof — PipRail's backendless scheme. The server reads Base and
//     verifies the payment locally; no facilitator, no custody, no fee.
//   • exact         — the ratified EIP-3009 scheme, settled gaslessly via the
//     PayAI facilitator (free + keyless — PayAI pays the gas), so a standard
//     x402 client (@x402/fetch, x402-fetch, …) can pay it with no PipRail code.
//
// Payment lands straight in PIPRAIL_PAYTO. No backend state, no database, no fee.
// Also serves /.well-known/x402 (free) so the resource is self-describing.

import {
  createPaymentGate,
  buildChallengeHeader,
  buildWellKnownX402,
  HEADER_REQUIRED,
  HEADER_SIGNATURE,
  HEADER_SIGNATURE_V1,
  HEADER_RESPONSE,
  HEADER_RESPONSE_V1,
  SettlementError,
} from '@piprail/sdk'

// payTo defaults to PipRail's recoverable test-merchant address; override in the
// Netlify UI (env var) to point demo revenue anywhere. Price is a trivial $0.01.
const PAY_TO = process.env.PIPRAIL_PAYTO ?? '0x28Dc25bf88BF06fc0a3Af1747D1aA4a21f313ed0'
const PRICE = process.env.PIPRAIL_PRICE ?? '0.01'
const RESOURCE = 'https://piprail.com/x402/demo'

// One gate, reused across warm invocations — its in-memory used-proof set is
// what stops a single proof being redeemed twice.
const gate = createPaymentGate({
  chain: 'base',
  token: 'USDC',
  amount: PRICE,
  payTo: PAY_TO,
  rpcUrl: process.env.BASE_RPC_URL, // optional Base RPC override (defaults to a public node)
  // Opt-in standard rail, settled gaslessly via a facilitator we don't run.
  exact: { settle: { facilitator: 'https://facilitator.payai.network' } },
})

// x402 discovery (the "bazaar" extension). Open indexes like x402scan require a
// v2 challenge to advertise an input schema at extensions.bazaar.info.input —
// otherwise they reject the listing with "Missing input schema". This endpoint
// is a plain GET with no input, so the schema is minimal. (The SDK emits the
// payment envelope; this discovery block is added at the response level here —
// a natural candidate to fold into the SDK as a first-class `discovery` option.)
const BAZAAR = {
  info: {
    input: { type: 'http', method: 'GET', queryParams: {} },
    output: { type: 'json', example: { paid: true } },
  },
  schema: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: {
      input: {
        type: 'object',
        properties: {
          type: { type: 'string', const: 'http' },
          method: { type: 'string', enum: ['GET', 'HEAD', 'DELETE'] },
          queryParams: { type: 'object', properties: {}, additionalProperties: false },
        },
        required: ['type', 'method'],
        additionalProperties: false,
      },
    },
    required: ['input'],
  },
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, payment-signature, x-payment',
  'access-control-expose-headers': [HEADER_REQUIRED, HEADER_RESPONSE, HEADER_RESPONSE_V1].join(', '),
}

const json = (body, status, extra = {}) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS, ...extra },
  })

// The "premium" content behind the paywall — a tiny demo payload + the receipt.
const premium = (receipt) => ({
  paid: true,
  message: '🎉 Payment verified by PipRail — no backend, no custody, no fee.',
  note: 'You just paid an HTTP API in stablecoin via x402. Build your own → https://piprail.com',
  receipt: {
    scheme: receipt.scheme, // 'onchain-proof' (backendless) or 'exact' (EIP-3009)
    payer: receipt.payer,
    amount: receipt.amount,
    asset: receipt.asset,
    network: receipt.network,
    transaction: receipt.transaction,
  },
})

// Return a 402, enriching the challenge with a self-described resource + discovery
// metadata, then REBUILDING the payment-required header so the (decoded) header the
// indexes read carries the same bazaar block as the body.
const challenge402 = (challenge) => {
  challenge.resource = {
    ...challenge.resource,
    method: 'GET',
    description: 'PipRail live x402 demo — pay $0.01 USDC on Base to unlock.',
    mimeType: 'application/json',
  }
  challenge.extensions = { ...(challenge.extensions ?? {}), bazaar: BAZAAR }
  return json(challenge, 402, { [HEADER_REQUIRED]: buildChallengeHeader(challenge) })
}

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })

  const { pathname } = new URL(req.url)

  // Free, nonce-less discovery manifest.
  if (pathname === '/.well-known/x402') {
    const desc = await gate.describe(RESOURCE)
    return json(buildWellKnownX402({ resources: [desc] }), 200)
  }

  const sig = req.headers.get(HEADER_SIGNATURE) ?? req.headers.get(HEADER_SIGNATURE_V1)

  // No payment yet → 402 with the dual-rail challenge + discovery metadata.
  if (!sig) {
    const { challenge } = await gate.challenge(RESOURCE)
    return challenge402(challenge)
  }

  // Payment present → verify. onchain-proof reads Base; exact forwards to PayAI.
  let result
  try {
    result = await gate.verify(sig)
  } catch (e) {
    // A thrown SettlementError is a server-side settle failure (→ 5xx, retryable);
    // client-fixable faults come back as kind:'invalid', never thrown.
    if (e instanceof SettlementError) return json({ error: 'settlement_failed', detail: e.message }, 502)
    return json({ error: 'internal_error', detail: String(e?.message ?? e) }, 500)
  }

  if (result.kind === 'paid') {
    return json(premium(result.receipt), 200, {
      [HEADER_RESPONSE]: result.receiptHeader,
      [HEADER_RESPONSE_V1]: result.receiptHeader,
    })
  }

  // Invalid proof → conformant 402 re-challenge (a real PaymentRequired, so a
  // standard client can simply re-pay).
  return challenge402(result.challenge)
}

// Netlify Functions v2 routing — this one function owns both paths.
export const config = { path: ['/x402/demo', '/.well-known/x402'] }

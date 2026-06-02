// Next.js App Router Route Handler, gated with PipRail.
//
// `requirePayment` is Express-only — every other framework (Next.js, Hono,
// Fastify, Workers, Bun, Deno) uses `createPaymentGate`, which is framework-
// agnostic: build a gate, then switch on what `verify()` returns.

import { createPaymentGate, toInvalidBody } from '@piprail/sdk'

// Build the gate once at module scope. It holds the payment requirement and an
// in-memory replay guard (pass isUsed/markUsed for multi-instance — e.g. Redis).
const gate = createPaymentGate({
  chain: 'base',
  token: 'USDC',
  amount: '0.05',
  payTo: '0xYourWallet…', // set from env in production, e.g. process.env.PAY_TO
})

export async function GET(req: Request): Promise<Response> {
  // The proof of payment (if any) rides in the `payment-signature` header.
  const result = await gate.verify(req.headers.get('payment-signature') ?? undefined)

  // Paid: return the resource + the receipt header.
  if (result.kind === 'paid') {
    return Response.json(
      { report: 'TOP SECRET' },
      { headers: { 'payment-response': result.receiptHeader } },
    )
  }

  // No proof yet: 402 + the challenge (header + body) telling the caller how to pay.
  if (result.kind === 'challenge') {
    return Response.json(result.challenge, {
      status: 402,
      headers: { 'payment-required': result.requiredHeader },
    })
  }

  // Proof rejected (wrong amount, expired, replayed…): 402 + canonical x402 body.
  return Response.json(toInvalidBody(result), { status: 402 })
}

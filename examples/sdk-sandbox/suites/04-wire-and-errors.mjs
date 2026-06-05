// Suite 04 — the raw wire codecs round-trip, and the typed error taxonomy
// (ERRORS.md) is reachable through the public API with stable `.code`s.

import {
  buildChallengeHeader, parseChallenge, buildSignatureHeader, parseSignatureHeader,
  buildReceiptHeader, parseReceipt, pickAccept, createPaymentGate, PipRailClient,
} from '@piprail/sdk'
import { startHostile, USDC_BASE, UNKNOWN_ASSET, BASE, SOLANA, USDC_SOLANA, SOLANA_PAYTO } from '../lib/hostile.mjs'
import { group, check, summarize } from '../lib/report.mjs'

const KEY = '0x' + '1'.repeat(64)
const DEAD = 'http://127.0.0.1:1'
const MERCHANT = '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A'

const accept = {
  scheme: 'onchain-proof', network: BASE, amount: '50000', asset: USDC_BASE, payTo: MERCHANT,
  maxTimeoutSeconds: 600, extra: { nonce: 'n1', decimals: 6, minConfirmations: 1, amountFormatted: '0.05', symbol: 'USDC' },
}

export async function run() {
  group('04 · wire codecs round-trip (the hand-rolled-client/server building blocks)')
  {
    const challenge = { x402Version: 2, error: null, resource: { url: 'u' }, accepts: [accept] }
    const cRes = new Response(null, { status: 402, headers: { 'payment-required': buildChallengeHeader(challenge) } })
    const parsedC = await parseChallenge(cRes)
    check('buildChallengeHeader → parseChallenge round-trips', parsedC?.accepts?.[0]?.amount === '50000' && parsedC.accepts[0].asset === USDC_BASE)

    const sig = { x402Version: 2, accepted: accept, payload: { nonce: 'n1', txHash: '0x' + 'a'.repeat(64) } }
    const parsedS = parseSignatureHeader(buildSignatureHeader(sig))
    check('buildSignatureHeader → parseSignatureHeader round-trips', parsedS?.payload?.txHash === sig.payload.txHash && parsedS.accepted.network === BASE)

    const receipt = { scheme: 'onchain-proof', success: true, network: BASE, transaction: '0x' + 'b'.repeat(64), asset: USDC_BASE, amount: '50000', payer: MERCHANT, payTo: MERCHANT, verifiedAt: '2026-01-01T00:00:00Z' }
    const rRes = new Response(null, { headers: { 'payment-response': buildReceiptHeader(receipt) } })
    const parsedR = parseReceipt(rRes)
    check('buildReceiptHeader → parseReceipt round-trips', parsedR?.transaction === receipt.transaction && parsedR.success === true)

    const multi = { x402Version: 2, error: null, resource: { url: 'u' }, accepts: [accept, { ...accept, network: SOLANA, asset: USDC_SOLANA, payTo: SOLANA_PAYTO }] }
    check('pickAccept selects by network', pickAccept(multi, (n) => n === BASE)?.asset === USDC_BASE && pickAccept(multi, (n) => n === SOLANA)?.asset === USDC_SOLANA)
    check('pickAccept returns null when no rail matches', pickAccept(multi, (n) => n === 'eip155:1') === null)
  }

  group('04 · typed errors are reachable with stable .code (ERRORS.md taxonomy)')
  {
    const evil = await startHostile({
      '/malformed': { asset: USDC_BASE, amount: 'not-an-integer', amountFormatted: '?', symbol: 'USDC' },
      '/unparseable': { unparseable: true },
      '/solana-only': { accepts: [{ network: SOLANA, asset: USDC_SOLANA, payTo: SOLANA_PAYTO, amount: 50_000, decimals: 6, amountFormatted: '0.05', symbol: 'USDC' }] },
    })
    const client = new PipRailClient({ chain: 'base', wallet: { privateKey: KEY }, rpcUrl: DEAD, policy: { tokens: ['USDC'] } })
    const codeOf = async (fn) => { try { await fn(); return '(no throw)' } catch (e) { return e.code ?? e.name } }

    check('INVALID_ENVELOPE — malformed amount in the challenge',
      (await codeOf(() => client.quote(`${evil.url}/malformed`))) === 'INVALID_ENVELOPE')
    check('INVALID_ENVELOPE — a 402 with no parseable challenge (no header + junk body)',
      (await codeOf(() => client.planPayment(`${evil.url}/unparseable`))) === 'INVALID_ENVELOPE')
    check('NO_COMPATIBLE_ACCEPT — 402 offered only on another chain',
      (await codeOf(() => client.quote(`${evil.url}/solana-only`))) === 'NO_COMPATIBLE_ACCEPT')
    check('NON_REPLAYABLE_BODY — a one-shot stream body (refused before any network)',
      (await codeOf(() => client.fetch('http://127.0.0.1:1/x', { method: 'POST', body: new ReadableStream() }))) === 'NON_REPLAYABLE_BODY')
    check('UNKNOWN_TOKEN — requirePayment with a symbol the chain doesn\'t ship',
      (await codeOf(() => createPaymentGate({ chain: 'base', token: 'DOGE', amount: '1', payTo: MERCHANT, rpcUrl: DEAD }).challenge('u'))) === 'UNKNOWN_TOKEN')
    check('WRONG_FAMILY — a Solana payTo on an EVM gate',
      (await codeOf(() => createPaymentGate({ chain: 'base', token: 'USDC', amount: '1', payTo: SOLANA_PAYTO, rpcUrl: DEAD }).challenge('u'))) === 'WRONG_FAMILY')

    await evil.close()
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await run()
  process.exit(summarize())
}

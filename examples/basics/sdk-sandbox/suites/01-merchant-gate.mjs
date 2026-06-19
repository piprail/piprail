// Suite 01 — the ACCEPT side: createPaymentGate / requirePayment.
// Genuine challenge construction, the wire header round-trip, and every verify()
// branch (challenge / lenient / unoffered-asset / bad-proof), the invalid-body
// shape, multi-accept challenges, and the form/family guards — all in-process.

import {
  createPaymentGate, parseChallenge, buildSignatureHeader, toInvalidBody,
  WrongFamilyError,
} from '@piprail/sdk'
import { privateKeyToAccount } from 'viem/accounts'
import { group, check, summarize } from '../lib/report.mjs'

const DEAD = 'http://127.0.0.1:1' // fast-failing RPC → verify's chain read returns tx_not_found, not a throw
const MERCHANT = privateKeyToAccount('0x' + '1'.repeat(64)).address
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

export async function run() {
  group('01 · createPaymentGate.challenge() builds a correct x402 envelope')
  const gate = createPaymentGate({ chain: 'base', token: 'USDC', amount: '0.05', payTo: MERCHANT, rpcUrl: DEAD, description: 'Report' })
  const { challenge, requiredHeader } = await gate.challenge('https://res.example/report')
  const a = challenge.accepts[0]
  check('x402Version 2, single accept', challenge.x402Version === 2 && challenge.accepts.length === 1)
  check('scheme onchain-proof on eip155:8453', a.scheme === 'onchain-proof' && a.network === 'eip155:8453')
  check('amount is base units (0.05 USDC → 50000)', a.amount === '50000')
  check('asset = canonical Base USDC, payTo = merchant', a.asset === USDC_BASE && a.payTo === MERCHANT)
  check('extra: 6 decimals, USDC, amountFormatted 0.05, a nonce, 1 conf',
    a.extra.decimals === 6 && a.extra.symbol === 'USDC' && a.extra.amountFormatted === '0.05' &&
      typeof a.extra.nonce === 'string' && a.extra.minConfirmations === 1)
  check('maxTimeoutSeconds default 600', a.maxTimeoutSeconds === 600)

  group('01 · the challenge header round-trips through parseChallenge')
  {
    const res = new Response(null, { status: 402, headers: { 'payment-required': requiredHeader } })
    const parsed = await parseChallenge(res)
    check('parseChallenge recovers the same accept', parsed?.accepts?.[0]?.amount === '50000' && parsed.accepts[0].asset === USDC_BASE)
  }

  group('01 · verify() — every branch')
  {
    const noProof = await gate.verify(undefined)
    check('no proof → kind:challenge (re-issues a 402)', noProof.kind === 'challenge' && noProof.statusCode === 402)

    const garbage = await gate.verify('not-a-valid-header')
    check('garbage header → kind:challenge (lenient, never 500s)', garbage.kind === 'challenge')

    // A proof claiming an asset this gate doesn't offer → invalid, never matched.
    const wrongAsset = buildSignatureHeader({
      x402Version: 2, accepted: { ...a, asset: 'native' }, payload: { nonce: a.extra.nonce, txHash: '0x' + '1'.repeat(64) },
    })
    const wa = await gate.verify(wrongAsset)
    check('proof for an UNOFFERED asset → invalid (transfer_not_found)', wa.kind === 'invalid' && wa.error === 'transfer_not_found')

    // A well-formed proof for the offered asset but a bogus tx → chain read fails → invalid (tx_not_found), not a throw.
    const bogus = buildSignatureHeader({ x402Version: 2, accepted: a, payload: { nonce: a.extra.nonce, txHash: '0x' + '9'.repeat(64) } })
    const bg = await gate.verify(bogus)
    check('well-formed proof, non-existent tx → invalid (tx_not_found), never throws', bg.kind === 'invalid' && bg.error === 'tx_not_found', bg.error)

    check('toInvalidBody shapes the canonical 402 body',
      JSON.stringify(toInvalidBody({ error: 'tx_reverted', detail: 'd' })) === JSON.stringify({ x402Version: 2, status: 'invalid', error: 'tx_reverted', detail: 'd' }))
  }

  group('01 · multi-accept challenge (one nonce, several rails)')
  {
    const multi = createPaymentGate({
      payTo: MERCHANT, rpcUrl: DEAD,
      accept: [{ chain: 'base', token: 'USDC', amount: '0.05' }, { chain: 'base', token: 'native', amount: '0.001' }],
    })
    const { challenge: c } = await multi.challenge('u')
    check('offers 2 rails (USDC + native) under one shared nonce',
      c.accepts.length === 2 && c.accepts[0].extra.nonce === c.accepts[1].extra.nonce &&
        c.accepts.some((x) => x.asset === USDC_BASE) && c.accepts.some((x) => x.asset === 'native'))
  }

  group('01 · guards — form mismatch & wrong-family payTo')
  {
    const both = createPaymentGate({ chain: 'base', token: 'USDC', amount: '0.05', payTo: MERCHANT, accept: [{ chain: 'base', token: 'USDC', amount: '0.05' }] })
    let threw = false
    try { await both.challenge('u') } catch (e) { threw = /EITHER|not both/i.test(e.message) }
    check('passing BOTH single + accept forms throws a clear error', threw)

    const neither = createPaymentGate({ payTo: MERCHANT })
    let threw2 = false
    try { await neither.challenge('u') } catch (e) { threw2 = /provide either/i.test(e.message) }
    check('passing NEITHER form throws a clear error', threw2)

    // A Solana address as payTo on an EVM gate → WrongFamilyError (code WRONG_FAMILY).
    const wrongFam = createPaymentGate({ chain: 'base', token: 'USDC', amount: '0.05', payTo: '11111111111111111111111111111111', rpcUrl: DEAD })
    let code = null
    try { await wrongFam.challenge('u') } catch (e) { code = e.code ?? e.name }
    check('a wrong-family payTo throws WrongFamilyError', code === 'WRONG_FAMILY' || code === WrongFamilyError.name, `code=${code}`)
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await run()
  process.exit(summarize())
}

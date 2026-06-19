// LIVE done-gate — PipRailClient({ schemes:['exact'] }) pays a REAL production x402 server
// (piprail.com/x402/demo) over the standard `exact` rail, settled by the keyless third-party
// PayAI facilitator on Base mainnet. This is the ONE proof a unit test / Anvil fork can't give:
// real-facilitator interop (validAfter='0' tolerance + the accepted-echo). Moves a TINY real
// amount ($0.01 USDC); the buyer pays ~0 gas (the facilitator broadcasts). Reads the payer key
// from .secrets at runtime, NEVER prints it. SKIPS VISIBLY if underfunded / no network.
import { readFileSync } from 'node:fs'
import { PipRailClient } from '../../../../sdk/dist/index.js'
import { group, check, note, summarize } from '../lib/report.mjs'

const DEMO = process.env.PIPRAIL_DEMO_URL ?? 'https://piprail.com/x402/demo'

export async function run() {
  group(`LIVE exact buyer · ${DEMO} (Base mainnet, real USDC via PayAI facilitator)`)
  let w
  try {
    w = JSON.parse(readFileSync(new URL('../../../../.secrets/wallets/evm-wallet.json', import.meta.url)))
  } catch {
    note('SKIPPED — .secrets/wallets/evm-wallet.json not found (this is the local-only done-gate).')
    return
  }

  // policy cap is a hard safety belt: this can never spend more than $0.05 on a payment.
  const client = new PipRailClient({
    chain: 'base',
    wallet: { key: w.privateKey },
    schemes: ['exact'], // pay ONLY the standard exact rail → exercises the PayAI facilitator
    policy: { maxAmount: '0.05', tokens: ['USDC'] },
    onEvent: (e) => { if (e.kind === 'payment-settled' && e.settle) note(`settle tx: ${e.settle.transaction} (payer ${e.settle.payer ?? '—'})`) },
  })

  // Pre-flight: confirm the exact rail is payable before moving funds.
  const plan = await client.planPayment(DEMO).catch((e) => ({ error: e?.message }))
  if (!plan || plan.error || !plan.payable) {
    note(`SKIPPED — exact rail not payable right now: ${plan?.error ?? plan?.fundingHint ?? 'endpoint not gated'}`)
    return
  }
  const opt = plan.options.find((o) => o.accept.scheme === 'exact')
  check('the live demo advertises a payable exact rail', Boolean(opt) && opt.state === 'payable', opt ? `state=${opt.state} bal=${opt.balance.token} USDC` : 'no exact rail')
  note(`paying ${opt.quote.amountFormatted} ${opt.quote.symbol} to ${opt.accept.payTo} via the exact rail (buyer gas ~0)…`)

  const before = Number(opt.balance.token)
  let res, body
  try {
    res = await client.fetch(DEMO, { schemes: ['exact'] })
    body = await res.json().catch(() => ({}))
  } catch (e) {
    check('exact round-trip settled (HTTP 200)', false, `${e?.constructor?.name}: ${e?.message}`)
    return
  }
  check('exact round-trip settled (HTTP 200, resource unlocked)', res.status === 200, `status=${res.status} body=${JSON.stringify(body).slice(0, 120)}`)
  check('the client recorded exactly one spend', client.spent().count === 1, `count=${client.spent().count}`)
  const rec = client.spent().records[0]
  if (rec) note(`spend ref: ${rec.ref}  amount: ${rec.amountFormatted} ${rec.symbol}`)

  // confirm the on-chain debit (best-effort re-read via a fresh plan)
  const after = await client.planPayment(DEMO).catch(() => null)
  const afterBal = after?.options?.find((o) => o.accept.scheme === 'exact')?.balance.token
  if (afterBal != null) check('payer USDC balance dropped by the paid amount', before - Number(afterBal) >= 0.0099, `before=${before} after=${afterBal}`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await run()
  process.exit(summarize())
}

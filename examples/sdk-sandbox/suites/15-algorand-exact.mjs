// Suite 15 — the Algorand `exact` rail (gasless via atomic-group fee pooling).
//
// Shows EXACTLY how PipRail's newest gasless rail works. Algorand has no per-account "fee payer"
// slot like Solana; instead a transaction GROUP pools fees, so one txn can over-pay and cover a
// fee-0 sibling. The canonical PipRail group is two txns:
//
//     [ buyer's ASA axfer → payTo, fee 0   (SIGNED by the buyer) ,
//       feePayer's 0-ALGO pay, fee = group total  (UNSIGNED — the sponsor signs it) ]
//
// The buyer signs ONLY the transfer at fee 0 → spends ZERO ALGO. The sponsor (the merchant's
// relayer in self mode, or a keyless facilitator) signs the pooled-fee txn + submits the group.
// Unlike Solana, feePayer === payTo is ALLOWED (the fee txn is separate — no isolation rule).
//
// OFFLINE + deterministic (a throwaway relayer account; no network, no funds move). For the REAL
// mainnet round-trip see suites/live-algorand-exact.mjs. Imports the LOCAL SDK build.
// Run: node suites/15-algorand-exact.mjs   (after `npm run build` in sdk/).

import algosdk from 'algosdk'
import { createPaymentGate, firstKeylessFacilitator } from '../../../sdk/dist/index.js'
import { group, check, note, summarize } from '../lib/report.mjs'

const ALGORAND = 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73k'

export async function run() {
  group('Algorand exact — what it is')
  note('A standard x402 `exact` rail on Algorand (ratified scheme_exact_algo). The buyer signs an')
  note('ASA transfer at FEE 0, atomically grouped with a 0-ALGO pay txn whose pooled fee covers the')
  note('whole group. Buyer pays ZERO ALGO; the sponsor (relayer OR keyless facilitator) pays the fee.')

  // A throwaway relayer (the merchant's own gas key). In self mode its address becomes the rail's
  // feePayer. (Real wallets are 25-word mnemonics; we generate one offline for the demo.)
  const relayer = algosdk.generateAccount()
  const relayerMnemonic = algosdk.secretKeyToMnemonic(relayer.sk)
  const relayerAddr = relayer.addr.toString()
  const payToAddr = algosdk.generateAccount().addr.toString()

  // ── (1) Self mode: the gate dual-advertises an Algorand exact rail (offline) ──
  group('1) self-settle: the gate advertises an Algorand exact rail beside onchain-proof')
  const selfGate = createPaymentGate({
    chain: 'algorand', token: 'USDC', amount: '0.05', payTo: payToAddr,
    exact: { settle: 'self', relayer: { key: relayerMnemonic } },
  })
  const { challenge } = await selfGate.challenge()
  const exact = challenge.accepts.find((a) => a.scheme === 'exact')
  check('an `exact` rail is advertised', Boolean(exact))
  check('method is `algorand` (the fee-pooled group scheme)', exact?.extra?.assetTransferMethod === 'algorand')
  check('the rail carries the sponsor as extra.feePayer (= the relayer)', exact?.extra?.feePayer === relayerAddr, exact?.extra?.feePayer)
  check('the asset is the USDC ASA id (31566704), 6 decimals', exact?.asset === '31566704' && exact?.extra?.decimals === 6)
  check('onchain-proof floor is ALSO advertised (the buyer-pays-gas fallback)', challenge.accepts.some((a) => a.scheme === 'onchain-proof'))
  note('A buyer signs the axfer at fee 0; the gate co-signs the pooled-fee txn + submits the group.')

  // ── (2) feePayer === payTo is allowed (Algorand-specific) ─────────────────────
  group('2) feePayer === payTo is allowed on Algorand (unlike Solana)')
  const merchant = algosdk.generateAccount()
  const merchantMnemonic = algosdk.secretKeyToMnemonic(merchant.sk)
  const selfPayGate = createPaymentGate({
    chain: 'algorand', token: 'USDC', amount: '0.05', payTo: merchant.addr.toString(),
    exact: { settle: 'self', relayer: { key: merchantMnemonic } }, // relayer === payTo
  })
  const cp = (await selfPayGate.challenge()).challenge.accepts.find((a) => a.scheme === 'exact')
  check('the merchant can be its OWN relayer (feePayer === payTo) — the fee txn is separate', cp?.extra?.feePayer === merchant.addr.toString())
  note('On Solana the fee payer must NOT be payTo (a MUST-rule); on Algorand it is fine.')

  // ── (3) exact: true on Algorand → graceful degrade (no keyless facilitator seeded) ──
  group('3) exact: true on Algorand → graceful degrade to onchain-proof (no keyless facilitator yet)')
  check('no keyless facilitator is seeded for Algorand yet (so exact:true degrades, not throws)', firstKeylessFacilitator(ALGORAND) === undefined)
  const warns = []
  const orig = console.warn
  console.warn = (...a) => warns.push(a.join(' '))
  let trueChallenge
  try {
    // The rail resolves LAZILY on the first challenge, so the degrade warning fires here.
    const trueGate = createPaymentGate({ chain: 'algorand', token: 'USDC', amount: '0.05', payTo: payToAddr, exact: true })
    trueChallenge = (await trueGate.challenge()).challenge
  } finally {
    console.warn = orig
  }
  check('exact: true did NOT throw — it degraded gracefully', Boolean(trueChallenge))
  check('the challenge serves onchain-proof (the buyer pays gas — Algorand fees are sub-cent)', trueChallenge.accepts.some((a) => a.scheme === 'onchain-proof'))
  check('a clear degrade warning was emitted (production-visible)', warns.some((w) => /ONCHAIN-PROOF ONLY|keyless facilitator/i.test(w)))
  note('Use `exact: { settle: \'self\', relayer }` for gasless on Algorand TODAY (proven on mainnet).')
  note('Once a keyless Algorand facilitator is live-settled + seeded, `exact: true` will be zero-config gasless here too.')

  note('▶ Real mainnet gasless round-trip: node suites/live-algorand-exact.mjs')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await run()
  process.exit(summarize())
}

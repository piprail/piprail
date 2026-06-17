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

const ALGORAND = 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8='

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

  // ── (3) exact: true on Algorand → NOW zero-config gasless (keyless GoPlausible seeded) ──
  // Offline check of the SEED resolution — `exact: true` auto-picks this facilitator. The live
  // challenge auto-discovers its sponsor from /supported (a network call), so that's in the live suite.
  group('3) exact: true on Algorand → zero-config gasless (the keyless GoPlausible facilitator is seeded)')
  const picked = firstKeylessFacilitator(ALGORAND)
  check('a keyless facilitator IS now seeded for Algorand (GoPlausible) → exact:true auto-picks it', picked?.url === 'https://facilitator.goplausible.xyz', picked?.url)
  check('it is keyless + settles the `algorand` method (the sponsor pays gas for BOTH sides)', picked?.keyless === true && picked?.settles.includes('algorand'))
  check('firstKeylessFacilitator(ALGORAND, "algorand") resolves it for the method too', firstKeylessFacilitator(ALGORAND, 'algorand')?.url === 'https://facilitator.goplausible.xyz')
  note('So `exact: true` on Algorand is zero-config gasless — both the buyer AND the merchant pay 0 ALGO.')
  note('(At challenge time it auto-discovers GoPlausible’s sponsor from /supported — see the live suite.)')
  note('Self-settle (`exact: { settle: \'self\', relayer }`) also works if you’d rather run your own relayer.')

  note('▶ Real mainnet gasless round-trips: node suites/live-algorand-exact.mjs (self) · live-algorand-goplausible.mjs (keyless)')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await run()
  process.exit(summarize())
}

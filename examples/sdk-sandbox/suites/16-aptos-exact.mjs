// Suite 16 — the Aptos `exact` rail (gasless via a fee-payer / sponsored transaction, AIP-39).
//
// Shows EXACTLY how PipRail's newest non-EVM gasless rail works. Aptos has native sponsored
// transactions: the buyer builds a `0x1::primary_fungible_store::transfer` to `payTo` with a fee
// payer set, and signs ONLY the sender slot — spending ZERO APT. The sponsor (the merchant's
// relayer in self mode, or a keyless facilitator) adds the fee-payer signature + submits, paying
// the sub-cent gas. One-shot: the buyer needs only the advertised `feePayer` (no gas-station
// round-trip). Like Algorand (and unlike Solana), feePayer === payTo is ALLOWED — the fee-payer
// signature is separate from the transfer.
//
// OFFLINE + deterministic (throwaway accounts; no network, no funds move). For the REAL mainnet
// round-trip see suites/live-aptos-exact.mjs. Imports the LOCAL SDK build.
// Run: node suites/16-aptos-exact.mjs   (after `npm run build` in sdk/).

import { Account } from '@aptos-labs/ts-sdk'
import { createPaymentGate, firstKeylessFacilitator } from '../../../sdk/dist/index.js'
import { group, check, note, summarize } from '../lib/report.mjs'

const APTOS = 'aptos:1'
const USDC_FA = '0xbae207659db88bea0cbead6da0ed00aac12edcdda169e591cd41c94180b46f3b'

export async function run() {
  group('Aptos exact — what it is')
  note('A standard x402 `exact` rail on Aptos (ratified scheme_exact_aptos). The buyer signs a')
  note('sponsored `primary_fungible_store::transfer`; the sponsor adds the fee-payer signature +')
  note('submits. Buyer pays ZERO APT; the sponsor (relayer OR keyless facilitator) pays the gas.')

  // A throwaway relayer (the merchant's own gas key). In self mode its address becomes the rail's
  // feePayer. (Generated offline for the demo; the key is an AIP-80 ed25519 secret.)
  const relayer = Account.generate()
  const relayerKey = relayer.privateKey.toString()
  const relayerAddr = relayer.accountAddress.toString()
  const payToAddr = Account.generate().accountAddress.toString()

  // ── (1) Self mode: the gate dual-advertises an Aptos exact rail (offline) ──
  group('1) self-settle: the gate advertises an Aptos exact rail beside onchain-proof')
  const selfGate = createPaymentGate({
    chain: 'aptos', token: 'USDC', amount: '0.05', payTo: payToAddr,
    exact: { settle: 'self', relayer: { key: relayerKey } },
  })
  const { challenge } = await selfGate.challenge()
  const exact = challenge.accepts.find((a) => a.scheme === 'exact')
  check('an `exact` rail is advertised', Boolean(exact))
  check('method is `aptos` (the fee-payer / sponsored-tx scheme)', exact?.extra?.assetTransferMethod === 'aptos')
  check('the rail carries the sponsor as extra.feePayer (= the relayer)', exact?.extra?.feePayer === relayerAddr, exact?.extra?.feePayer)
  check('the asset is the native Circle USDC FA metadata, 6 decimals', exact?.asset === USDC_FA && exact?.extra?.decimals === 6)
  check('onchain-proof floor is ALSO advertised (the buyer-pays-gas fallback)', challenge.accepts.some((a) => a.scheme === 'onchain-proof'))
  note('A buyer signs the transfer (sender slot only); the gate adds the fee-payer signature + submits.')

  // ── (2) feePayer === payTo is allowed (like Algorand, unlike Solana) ──────────
  group('2) feePayer === payTo is allowed on Aptos (the fee-payer signature is separate)')
  const merchant = Account.generate()
  const selfPayGate = createPaymentGate({
    chain: 'aptos', token: 'USDC', amount: '0.05', payTo: merchant.accountAddress.toString(),
    exact: { settle: 'self', relayer: { key: merchant.privateKey.toString() } }, // relayer === payTo
  })
  const cp = (await selfPayGate.challenge()).challenge.accepts.find((a) => a.scheme === 'exact')
  check('the merchant can be its OWN relayer (feePayer === payTo)', cp?.extra?.feePayer === merchant.accountAddress.toString())
  note('On Solana the fee payer must NOT be payTo (a MUST-rule); on Aptos/Algorand it is fine.')

  // ── (3) exact: true on Aptos → graceful degrade (no keyless facilitator seeded) ──
  group('3) exact: true on Aptos → graceful degrade to onchain-proof (no keyless facilitator yet)')
  check('no keyless facilitator is seeded for Aptos yet (so exact:true degrades, not throws)', firstKeylessFacilitator(APTOS) === undefined)
  const warns = []
  const orig = console.warn
  console.warn = (...a) => warns.push(a.join(' '))
  let trueChallenge
  try {
    // The rail resolves LAZILY on the first challenge, so the degrade warning fires here.
    const trueGate = createPaymentGate({ chain: 'aptos', token: 'USDC', amount: '0.05', payTo: payToAddr, exact: true })
    trueChallenge = (await trueGate.challenge()).challenge
  } finally {
    console.warn = orig
  }
  check('exact: true did NOT throw — it degraded gracefully', Boolean(trueChallenge))
  check('the challenge serves onchain-proof (the buyer pays gas — Aptos fees are sub-cent)', trueChallenge.accepts.some((a) => a.scheme === 'onchain-proof'))
  check('a clear degrade warning was emitted (production-visible)', warns.some((w) => /ONCHAIN-PROOF ONLY|keyless facilitator/i.test(w)))
  note('Use `exact: { settle: \'self\', relayer }` for gasless on Aptos TODAY (proven on mainnet).')
  note('Aptos has no keyless x402 facilitator yet (build-own only), so `exact: true` stays onchain-proof here.')

  note('▶ Real mainnet gasless round-trip: node suites/live-aptos-exact.mjs')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await run()
  process.exit(summarize())
}

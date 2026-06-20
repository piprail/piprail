// Suite 01 — VERIFIABLE RECEIPTS  (chain-grounded R1 + EIP-712 attestation R2)
//
// A PipRail receipt is a self-contained, portable proof that a payment REALLY settled — anyone
// can re-verify it against the chain with no wallet and no trust in whoever handed it over.
//
//   OFFLINE (always): a receipts-enabled 402 self-advertises `verifiableReceipts`; the static
//     verifiers are read-only and NEVER throw on malformed input (the SDK contract).
//   LIVE (Base mainnet, tiny USDC — only with the .secrets wallet):
//     pay onchain-proof → gate emits R1 (chain-grounded) + R2 (EIP-712, signed by payTo) →
//     verifyReceipt re-confirms it on-chain → a FORGED payer is caught (matchesClaims:false) →
//     verifyAttestation recovers payTo → §5.3 suppressed-tx still verifies via R2 → replay rejected.
//
import { createPaymentGate, PipRailClient, buildSelfDescription, decodeBase64Json, EXT_OFFER_RECEIPT } from '@piprail/sdk'
import { check, banner, group, note, skip, done } from '../lib/report.mjs'
import { loadWallet, merchantKey, RPC, USDC, usdcBalance, getAddress, formatUnits } from '../lib/env.mjs'
import { serveGate } from '../lib/http-gate.mjs'

banner('01 · VERIFIABLE RECEIPTS')
const w = loadWallet()
const MERCHANT = w?.merchant ?? '0x28Dc25bf88BF06fc0a3Af1747D1aA4a21f313ed0'

// ───────────────────────── OFFLINE (no chain, no money) ─────────────────────────
group('offline — the receipts 402 self-advertises + the verifiers never throw')
{
  const gate = createPaymentGate({ chain: 'base', token: 'USDC', amount: '0.001', payTo: MERCHANT, rpcUrl: RPC, receipts: true })
  const c = await gate.challenge('http://127.0.0.1:1/r')
  check(c.challenge.extensions?.piprail?.verifiableReceipts === true, 'receipts:true → the 402 advertises extensions.piprail.verifiableReceipts')
  check(!!c.challenge.accepts.find((a) => a.scheme === 'onchain-proof'), 'the 402 offers an onchain-proof rail')

  const sd = buildSelfDescription({ accepts: c.challenge.accepts, verifiableReceipts: true })
  check(sd.verifiableReceipts === true, 'buildSelfDescription surfaces verifiableReceipts:true')

  // The static verifiers are read-only + WALLET-FREE and must return a verdict, never throw —
  // even when the input is junk or the RPC is unreachable.
  const v0 = await PipRailClient.verifyReceipt({}, { rpcUrl: RPC })
  check(v0 && v0.ok === false, 'verifyReceipt({}) → ok:false (read-only, never throws on malformed input)')
  const a0 = await PipRailClient.verifyAttestation({})
  check(a0 && a0.ok === false, 'verifyAttestation({}) → ok:false (never throws)')
}

// ───────────────────────── LIVE (Base mainnet) ─────────────────────────
if (!w) {
  skip('no .secrets wallet → skipping the live Base-mainnet receipts round-trip')
} else {
  const mKey = merchantKey(w)

  group('live — onchain-proof settle → R1 + R2 → re-verify → forge → replay')
  {
    const gate = createPaymentGate({
      chain: 'base', token: 'USDC', amount: '0.001', payTo: w.merchant, rpcUrl: RPC,
      receipts: { attest: { wallet: { key: mKey } }, resource: 'http://127.0.0.1:4801/api/report' },
      onPaid: (r) => console.log(`  💰 settled ${r.amountFormatted} ${r.symbol} — tx ${r.transaction?.slice(0, 14)}…`),
    })
    const srv = serveGate(gate, { port: 4801, path: '/api/report', body: { ok: true } })
    await srv.listen()
    try {
      const buyer = new PipRailClient({ chain: 'base', wallet: { key: w.key }, rpcUrl: RPC })
      note('paying onchain-proof: payer broadcasts USDC + pays its own gas')
      const res = await buyer.fetch(srv.url)
      check(res.status === 200, 'payment settled (HTTP 200)')

      const receipt = buyer.lastReceipt()
      check(receipt?.piprail === '1', 'client.lastReceipt() returned a self-contained PipRailReceipt')
      check(!!receipt?.attestation, 'the receipt carries a Tier-2 EIP-712 attestation')
      note(`receipt scheme=${receipt?.receipt.scheme} tx=${receipt?.receipt.transaction?.slice(0, 14)}… amount=${receipt?.receipt.amount}`)

      // R1 — re-verify against Base mainnet, wallet-free.
      const v = await PipRailClient.verifyReceipt(receipt, { rpcUrl: RPC })
      check(v.ok === true, 'verifyReceipt re-confirms the settlement ON-CHAIN (ok)')
      check(v.matchesClaims === true, 'matchesClaims — the receipt did not lie about any field')
      check(v.onChain.payTo.toLowerCase() === w.merchant.toLowerCase(), 'the chain confirms the settlement paid the claimed payTo (=== merchant)')
      check(v.onChain.payer.toLowerCase() === w.payer.toLowerCase(), 're-derived payer === the real buyer (extracted from the tx, not trusted from the receipt)')

      // Forgery — tamper the claimed payer; the re-derived (on-chain) payer wins.
      const forged = { ...receipt, receipt: { ...receipt.receipt, payer: '0x000000000000000000000000000000000000dEaD' } }
      const vf = await PipRailClient.verifyReceipt(forged, { rpcUrl: RPC })
      check(vf.ok === true && vf.matchesClaims === false, 'a FORGED payer is caught (ok:true but matchesClaims:false)')

      // R2 — the EIP-712 attestation recovers payTo as the signer.
      const a = await PipRailClient.verifyAttestation(receipt)
      check(a.ok === true, 'verifyAttestation recovers a valid signer')
      check((a.signer ?? '').toLowerCase() === w.merchant.toLowerCase(), 'attestation signer === payTo (merchant)')

      // A2A seam: verifyObject(rawObject) and verify(b64) funnel into the same verdict core. The
      // proof has already settled (above), so both re-run it and must AGREE on the REPLAY rejection.
      // (The kind:'paid' SETTLE-equivalence over A2A is proven live in suite 04.)
      const viaB64 = await gate.verify(srv.lastSig())
      const viaObj = await gate.verifyObject(decodeBase64Json(srv.lastSig()))
      check(viaB64.kind === viaObj.kind && viaB64.error === viaObj.error, 'verifyObject(rawJSON) and verify(b64) agree on the verdict (here: the replay rejection)')
      // Replay — the settled proof is single-use.
      check(viaB64.kind === 'invalid' && viaB64.error === 'tx_already_used', 'replay of the settled proof is rejected (tx_already_used)')
    } catch (err) {
      check(false, `live receipts threw: ${err?.message ?? err}`)
    } finally {
      srv.close()
    }
  }

  // §5.3 — a SUPPRESSED tx-hash receipt (privacy) still verifies via the R2 attestation.
  group('live — §5.3 includeTxHash:false → transaction:"" on the wire AND in the signed attestation')
  {
    const gate2 = createPaymentGate({
      chain: 'base', token: 'USDC', amount: '0.001', payTo: w.merchant, rpcUrl: RPC,
      receipts: { includeTxHash: false, attest: { wallet: { key: mKey } }, resource: 'http://127.0.0.1:4802/r' },
    })
    const srv2 = serveGate(gate2, { port: 4802, path: '/r', body: { ok: true } })
    await srv2.listen()
    try {
      const buyer = new PipRailClient({ chain: 'base', wallet: { key: w.key }, rpcUrl: RPC })
      const res = await buyer.fetch(srv2.url)
      check(res.status === 200, 'suppressed-tx receipt path settled (HTTP 200)')
      const rcpt = buyer.lastReceipt()
      check(rcpt?.receipt.transaction === '', "receipt.transaction === '' (suppressed per §5.3)")
      const info = decodeBase64Json(srv2.lastResp())?.extensions?.[EXT_OFFER_RECEIPT]?.info
      check(info?.receipt?.payload?.transaction === '', "the SIGNED attestation also carries transaction:'' (not just the wire)")
      const a = await PipRailClient.verifyAttestation(rcpt)
      check(a.ok === true && (a.signer ?? '').toLowerCase() === w.merchant.toLowerCase(), 'R2 attestation STILL verifies with no tx hash')
      const vNoTx = await PipRailClient.verifyReceipt(rcpt, { rpcUrl: RPC })
      check(vNoTx.ok === false, 'verifyReceipt cannot on-chain-verify a suppressed-tx receipt (ok:false, no throw)')
    } catch (err) {
      check(false, `suppressed-tx leg threw: ${err?.message ?? err}`)
    } finally {
      srv2.close()
    }
  }
}

done(w ? '01 receipts' : '01 receipts (offline)')

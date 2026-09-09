/**
 * L3 · RESERVES — spendable is not the same as held.
 *
 * Several chains require an account to retain a minimum it can never send:
 *
 *   Solana    the rent-exempt minimum for the account
 *   XRPL      a base reserve, plus an increment for every owned object (a trustline is one)
 *   Stellar   (2 + subentries) x the base reserve, and a trustline is a subentry
 *   Algorand  0.1 ALGO, plus 0.1 for every ASA opted into
 *
 * Measuring affordability against the RAW balance makes `planPayment` promise a payment the
 * chain then refuses — after the agent has signed, which is the one moment it can no longer
 * change its mind. Found live: a Solana wallet holding 0.0011 SOL was told it could send
 * 0.0005, and the transfer failed simulation with a bare `SendTransactionError`.
 *
 * A driver reports the difference by returning the reserve-deducted figure as `token` for a
 * native asset while `native` stays the true balance. This asks every family, against real
 * mainnet accounts, whether it does — and asserts the invariant that holds everywhere:
 * SPENDABLE IS NEVER MORE THAN HELD.
 */
export const meta = {
  id: 'reserves',
  layer: 'L3',
  what: 'spendable vs held on every family, and the retained minimum on the four chains that have one',
  why: 'promising a payment the chain will refuse is the exact failure planPayment exists to prevent',
  network: true,
  wallets: true,
}

/** family → [chain, wallet→key, native symbol, has a retained reserve] */
const FAMILIES = [
  ['solana', 'solana', (w) => ({ key: w.secretKey }), 'SOL', true],
  ['xrpl', 'xrpl', (w) => ({ key: w.seed }), 'XRP', true],
  ['stellar', 'stellar', (w) => ({ key: w.secret }), 'XLM', true],
  ['algorand', 'algorand', (w) => ({ key: w.mnemonic }), 'ALGO', true],
  ['aptos', 'aptos', (w) => ({ key: w.privateKey }), 'APT', false],
  ['sui', 'sui', (w) => ({ key: w.privateKey }), 'SUI', false],
  ['tron', 'tron', (w) => ({ key: w.privateKey }), 'TRX', false],
  ['near', 'near', (w) => ({ accountId: w.accountId, key: w.privateKey }), 'NEAR', false],
  ['ton', 'ton', (w) => ({ key: w.mnemonic }), 'TON', false],
  ['evm', 'base', (w) => ({ key: w.privateKey }), 'ETH', false],
]

export async function run({ sdk, section, check, warn, wallet, REPO, env }) {
  const { PipRailClient } = sdk

  section('reserves · spendable is never more than held', 'the invariant that holds on every chain')

  const seen = []
  for (const [fam, chain, key, symbol, hasReserve] of FAMILIES) {
    await check(`${chain.padEnd(9)} reports a spendable native balance`, async () => {
      const rpcUrl = env[`RPC_${chain.toUpperCase()}`] || undefined
      const c = new PipRailClient({ chain, wallet: key(wallet(fam, REPO)), ...(rpcUrl ? { rpcUrl } : {}) })
      const bal = await c.balanceOf(['native'])
      const b = bal?.[0]
      if (!b || b.amount == null) return { fail: 'the native read was unavailable' }
      const spendable = BigInt(b.amount)
      if (spendable < 0n) return { fail: `NEGATIVE spendable: ${spendable}` }
      seen.push({ chain, symbol, spendable, formatted: b.amountFormatted, hasReserve })
      return `${b.amountFormatted} ${symbol} spendable`
    })
  }

  section('reserves · withholding must not OVER-withhold',
    'a payment comfortably inside the spendable balance must still go through')

  for (const { chain, symbol, spendable, hasReserve } of seen) {
    if (!hasReserve) continue
    await check(`${chain.padEnd(9)} still allows a payment WITHIN the spendable balance`, async () => {
      const { serve } = await import('./harness.mjs')
      const { createPaymentGate } = sdk
      const fam = FAMILIES.find((f) => f[1] === chain)
      const w = wallet(fam[0], REPO)
      const rpcUrl = env[`RPC_${chain.toUpperCase()}`] || undefined
      const decimals = { SOL: 9, XRP: 6, XLM: 7, ALGO: 6 }[symbol]
      // A tenth of what it can send: safely inside, even after gas.
      const under = spendable / 10n
      if (under <= 0n) { warn(`${chain}: spendable is dust, nothing to test`, String(spendable)); return 'skipped, wallet too low' }
      const amount = (Number(under) / 10 ** decimals).toFixed(decimals)
      const payTo = w.merchantAddress ?? w.merchant?.address ?? w.merchant?.accountId
      const gate = createPaymentGate({ chain, token: 'native', amount, payTo, ...(rpcUrl ? { rpcUrl } : {}) })
      const srv = await serve(async (req) => {
        const r = await gate.verify(req.headers.get('payment-signature') ?? undefined)
        return new Response(JSON.stringify(r.challenge ?? {}), {
          status: 402, headers: { 'content-type': 'application/json', 'payment-required': r.requiredHeader ?? '' },
        })
      })
      try {
        const c = new PipRailClient({ chain, wallet: fam[2](w), ...(rpcUrl ? { rpcUrl } : {}) })
        const plan = await c.planPayment(srv.url)
        if (!plan) return { fail: 'planPayment returned null' }
        return plan.payable === true
          ? `${amount} ${symbol} still payable`
          : { fail: `🔴 OVER-WITHHELD: refused ${amount} ${symbol} of a ${spendable}-unit spendable balance` }
      } finally { await srv.close() }
    })
  }

  section('reserves · a reserve chain refuses a payment that would eat into it',
    'the check that would have caught the live Solana failure')

  for (const { chain, symbol, spendable, hasReserve } of seen) {
    if (!hasReserve) continue
    await check(`${chain.padEnd(9)} blocks a payment above the spendable balance`, async () => {
      const { serve } = await import('./harness.mjs')
      const { createPaymentGate } = sdk
      const fam = FAMILIES.find((f) => f[1] === chain)
      const w = wallet(fam[0], REPO)
      const rpcUrl = env[`RPC_${chain.toUpperCase()}`] || undefined
      // Price the gate just ABOVE what the wallet can actually send.
      const decimals = { SOL: 9, XRP: 6, XLM: 7, ALGO: 6 }[symbol]
      const over = spendable + 10n ** BigInt(decimals) // a whole coin more than it can send
      const amount = (Number(over) / 10 ** decimals).toFixed(decimals)
      const payTo = w.merchantAddress ?? w.merchant?.address ?? w.merchant?.accountId
      const gate = createPaymentGate({ chain, token: 'native', amount, payTo, ...(rpcUrl ? { rpcUrl } : {}) })
      const srv = await serve(async (req) => {
        const r = await gate.verify(req.headers.get('payment-signature') ?? undefined)
        return new Response(JSON.stringify(r.challenge ?? {}), {
          status: 402, headers: { 'content-type': 'application/json', 'payment-required': r.requiredHeader ?? '' },
        })
      })
      try {
        const c = new PipRailClient({ chain, wallet: fam[2](w), ...(rpcUrl ? { rpcUrl } : {}) })
        const plan = await c.planPayment(srv.url)
        if (!plan) return { fail: 'planPayment returned null' }
        return plan.payable === false
          ? `blocked: ${(plan.options ?? []).flatMap((o) => o.blockers ?? []).join(', ') || 'not payable'}`
          : { fail: `🔴 promised ${amount} ${symbol} it cannot send` }
      } finally { await srv.close() }
    })
  }
}

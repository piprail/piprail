/**
 * The spend leash under CONCURRENT payments.
 *
 * A cap is read when a quote is priced and written when the payment settles, and a whole
 * network round trip sits between the two. Without a reservation, N simultaneous payments each
 * price against the same "spent so far", each pass, and each settle — an agent with a 2.50 cap
 * spends 4.00 while every individual check was correct. It is the same read-await-write shape
 * that let one proof be redeemed N times, on the buyer's side of the wire instead of the
 * merchant's, and it is the whole safety story for the DEFAULT `budgeted` mode.
 *
 * `authorize()` now reserves synchronously before anything is signed; `recordSpend()` commits,
 * and every failure path releases.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { PipRailClient } from '../src/client.js'
import { createPaymentGate } from '../src/server.js'
import { SpendLedger } from '../src/ledger.js'
import { memorySpendStore } from '../src/spendstore.js'
import { registerDriver } from '../src/drivers/index.js'
import type { PaymentDriver } from '../src/drivers/types.js'

const PAY_TO = '0x3333333333333333333333333333333333333333'
const CHAIN = { id: 8453, rpcUrl: 'https://fake.example/rpc' }

let sendCounter = 0
let sendDelayMs = 5

const fakeEvm: PaymentDriver = {
  family: 'evm',
  resolve(opts) {
    const chain = opts.chain as { id?: number }
    if (typeof chain !== 'object' || typeof chain.id !== 'number') return null
    const network = `eip155:${chain.id}` as const
    return {
      family: 'evm',
      network,
      supports: (n) => n === network,
      resolveToken: () => ({ asset: `0x${'a'.repeat(40)}`, decimals: 6, symbol: 'USDC' }),
      describeAsset: () => ({ symbol: 'USDC', decimals: 6 }),
      assertValidPayTo: () => undefined,
      bindWallet: (w) => ({ _native: w }),
      // A unique ref per send, and a real await: the gap between pricing and settling is
      // exactly where the race lives, so a synchronous fake would hide the bug.
      send: async () => {
        if (sendDelayMs) await new Promise((r) => setTimeout(r, sendDelayMs))
        return `0x${(++sendCounter).toString(16).padStart(64, 'e')}`
      },
      confirm: async () => ({ height: '1' }),
      estimateCost: async () => ({
        feeSymbol: 'ETH', feeDecimals: 18, fee: '0', feeFormatted: '0', basis: 'heuristic' as const,
      }),
      addressOf: async () => '0xself',
      balanceOf: async () => ({ token: 10n ** 12n, native: 10n ** 18n }),
      recipientReady: async () => ({ ready: 'n/a' as const }),
      verify: async (ref, accept) => ({
        ok: true,
        receipt: {
          scheme: 'onchain-proof', success: true, network: accept.network, transaction: ref,
          asset: accept.asset, amount: accept.amount, payer: '0xpayer', payTo: accept.payTo,
          verifiedAt: 'now',
        },
      }),
    }
  },
}
registerDriver(fakeEvm)

/** A gate charging 1.00 a call, served over a real loopback socket. */
async function payableUrl() {
  const http = await import('node:http')
  const gate = createPaymentGate({ chain: CHAIN, token: 'USDC', amount: '1.00', payTo: PAY_TO })
  const server = http.createServer(async (req, res) => {
    const sig = req.headers['payment-signature']
    const r = await gate.verify(typeof sig === 'string' ? sig : undefined)
    if (r.kind === 'paid') {
      res.writeHead(200, { 'content-type': 'application/json', 'payment-response': r.receiptHeader })
      res.end(JSON.stringify({ ok: true }))
      return
    }
    res.writeHead(402, { 'content-type': 'application/json', 'payment-required': r.requiredHeader })
    res.end(JSON.stringify(r.challenge))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const port = (server.address() as { port: number }).port
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) }
}

const client = (policy: Record<string, unknown>) =>
  new PipRailClient({ chain: CHAIN, wallet: { key: `0x${'1'.repeat(64)}` }, policy } as never)

const paidCount = (rs: PromiseSettledResult<Response>[]) =>
  rs.filter((r) => r.status === 'fulfilled' && r.value.status === 200).length

beforeEach(() => { sendCounter = 0; sendDelayMs = 5 })

describe('a spend cap holds when payments run in parallel', () => {
  it('maxTotal: six at once cannot spend more than the cap allows', async () => {
    const srv = await payableUrl()
    try {
      const c = client({ maxTotal: '2.50' }) // 1.00 each → at most two
      const rs = await Promise.allSettled(Array.from({ length: 6 }, () => c.fetch(srv.url)))
      expect(paidCount(rs)).toBeLessThanOrEqual(2)
    } finally { await srv.close() }
  })

  it('maxPayments: the COUNT leash holds too', async () => {
    const srv = await payableUrl()
    try {
      const c = client({ maxPayments: 2 })
      const rs = await Promise.allSettled(Array.from({ length: 6 }, () => c.fetch(srv.url)))
      expect(paidCount(rs)).toBeLessThanOrEqual(2)
    } finally { await srv.close() }
  })

  it('maxTotalPerDenom: the cross-token grand total holds', async () => {
    const srv = await payableUrl()
    try {
      const c = client({ maxTotalPerDenom: { USD: '2.50' } })
      const rs = await Promise.allSettled(Array.from({ length: 6 }, () => c.fetch(srv.url)))
      expect(paidCount(rs)).toBeLessThanOrEqual(2)
    } finally { await srv.close() }
  })

  it('the ledger afterwards agrees with what was actually paid', async () => {
    const srv = await payableUrl()
    try {
      const c = client({ maxTotal: '2.50' })
      const rs = await Promise.allSettled(Array.from({ length: 6 }, () => c.fetch(srv.url)))
      const paid = paidCount(rs)
      const summary = c.spent()
      expect(summary.count).toBe(paid)
      expect(summary.byAsset[0]?.totalBase ?? '0').toBe(String(paid * 1_000_000))
    } finally { await srv.close() }
  })
})

describe('a reservation is never leaked', () => {
  it('a REFUSED payment does not permanently consume the leash', async () => {
    const srv = await payableUrl()
    try {
      // Decline the first two, then allow: if a refusal kept its reservation, the later
      // payments would be declined too and the cap would silently shrink for good.
      let calls = 0
      const c = new PipRailClient({
        chain: CHAIN, wallet: { key: `0x${'1'.repeat(64)}` },
        policy: { maxTotal: '10.00' },
        onBeforePay: async () => ++calls > 2,
      } as never)

      for (let i = 0; i < 2; i++) await expect(c.fetch(srv.url)).rejects.toThrow()
      const ok = await c.fetch(srv.url)
      expect(ok.status).toBe(200)
      // Only the settled payment is on the books; the two refusals left nothing behind.
      expect(c.spent().count).toBe(1)
    } finally { await srv.close() }
  })

  it('sequential payments still spend the full cap (the reserve does not over-hold)', async () => {
    const srv = await payableUrl()
    try {
      const c = client({ maxTotal: '3.00' })
      let paid = 0
      for (let i = 0; i < 5; i++) {
        try { if ((await c.fetch(srv.url)).status === 200) paid++ } catch { /* declined */ }
      }
      expect(paid).toBe(3) // exactly the cap, no more and no fewer
    } finally { await srv.close() }
  })
})

describe('SpendLedger reservations', () => {
  it('a reservation counts toward totals, and release gives it back', () => {
    const l = new SpendLedger(memorySpendStore())
    expect(l.totalFor('eip155:8453', '0xa')).toBe(0n)
    const t = l.reserve('eip155:8453', '0xa', 1_000_000n, 6, 'USD')
    expect(l.totalFor('eip155:8453', '0xa')).toBe(1_000_000n)
    expect(l.totalForDenom('USD')).toBeGreaterThan(0n)
    expect(l.count()).toBe(1)
    l.release(t)
    expect(l.totalFor('eip155:8453', '0xa')).toBe(0n)
    expect(l.totalForDenom('USD')).toBe(0n)
    expect(l.count()).toBe(0)
  })

  it('release is idempotent and ignores an unknown token', () => {
    const l = new SpendLedger(memorySpendStore())
    const t = l.reserve('eip155:8453', '0xa', 1n, 6)
    l.release(t)
    l.release(t)
    l.release(undefined)
    l.release('never-issued')
    expect(l.count()).toBe(0)
  })

  it('a reservation for one asset does not weigh on another', () => {
    const l = new SpendLedger(memorySpendStore())
    l.reserve('eip155:8453', '0xa', 5_000_000n, 6)
    expect(l.totalFor('eip155:8453', '0xb')).toBe(0n)
    expect(l.totalFor('eip155:137', '0xa')).toBe(0n)
  })
})

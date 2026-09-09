/**
 * Merchant CONFIG must fail at construction, not in production.
 *
 * The gate validates amounts strictly (`parseUnits` rejects negatives, e-notation, extra
 * decimals), and these pin the two places that strictness did not reach:
 *
 *   1. a chain id that is not an EIP-155 chain id. `{ id: NaN }` resolved happily and the gate
 *      published `network: "eip155:NaN"` in a live 402 — an unparseable CAIP-2. It failed
 *      closed later, but as `tx_not_found` at PAYMENT time rather than as the config error it is.
 *   2. an amount of zero. `parseUnits` allows "0" because a metered `upto` SETTLE of zero is a
 *      legitimate zero-charge receipt, but that is the settled amount, not the advertised one.
 *      A gate advertising 0 gates nothing while reading as configured.
 */
import { describe, it, expect } from 'vitest'
import { createPaymentGate } from '../src/server.js'
import { resolveChain } from '../src/drivers/evm/chains.js'
import { InvalidConfigError } from '../src/errors.js'

const PAY_TO = '0x3333333333333333333333333333333333333333'
const RPC = 'https://fake.example/rpc'

describe('resolveChain — a chain id must be an EIP-155 chain id', () => {
  for (const [label, id] of [
    ['NaN', NaN],
    ['negative', -1],
    ['zero', 0],
    ['fractional', 1.5],
    ['beyond Number.MAX_SAFE_INTEGER', Number.MAX_SAFE_INTEGER + 2],
    ['Infinity', Infinity],
  ] as const) {
    it(`rejects ${label}`, () => {
      expect(() => resolveChain({ id: id as number, rpcUrl: RPC })).toThrow(InvalidConfigError)
    })
  }

  it('still accepts any real chain id — there is no allowlist', () => {
    const r = resolveChain({ id: 1313161554, rpcUrl: RPC }) // Aurora, not a built-in
    expect(r.chainId).toBe(1313161554)
  })

  it('a built-in name is unaffected', () => {
    expect(resolveChain('base').chainId).toBe(8453)
  })
})

describe('a gate must charge something', () => {
  const base = { chain: { id: 8453, rpcUrl: RPC }, token: 'USDC', payTo: PAY_TO } as const

  it('rejects amount "0" at challenge time', async () => {
    const gate = createPaymentGate({ ...base, amount: '0' })
    await expect(gate.challenge('https://x.test/r')).rejects.toThrow(/greater than zero/)
  })

  it('rejects an amount that rounds to zero at the token decimals', async () => {
    // 6dp USDC: 0.0000001 floors to 0 base units, which would gate nothing.
    const gate = createPaymentGate({ ...base, amount: '0.0000001' })
    await expect(gate.challenge('https://x.test/r')).rejects.toThrow()
  })

  it('rejects a zero amount on ONE rail of a multi-chain accept[]', async () => {
    const gate = createPaymentGate({
      accept: [
        { chain: { id: 8453, rpcUrl: RPC }, token: 'USDC', amount: '0.05', payTo: PAY_TO },
        { chain: { id: 137, rpcUrl: RPC }, token: 'USDC', amount: '0', payTo: PAY_TO },
      ],
    })
    await expect(gate.challenge('https://x.test/r')).rejects.toThrow(/greater than zero/)
  })

  it('still accepts the smallest representable amount', async () => {
    const gate = createPaymentGate({ ...base, amount: '0.000001' }) // 1 base unit of 6dp USDC
    const { challenge } = await gate.challenge('https://x.test/r')
    expect(challenge.accepts[0]!.amount).toBe('1')
  })
})

describe('piprail_sell inherits the same floor', () => {
  it('a zero price cannot mint an offer', async () => {
    const { PipRailClient, paymentTools } = await import('../src/index.js')
    const client = new PipRailClient({
      chain: { id: 8453, rpcUrl: RPC }, wallet: { key: '0xk' },
      mode: 'sovereign', swapPolicy: { maxPerSwap: '9' },
    } as never)
    const sell = paymentTools(client).find((t) => t.name === 'piprail_sell')!
    const r = (await sell.invoke({ description: 'x', price: '0' })) as Record<string, unknown>
    expect(r.ok).toBe(false)
  })
})

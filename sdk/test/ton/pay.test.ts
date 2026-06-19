import { describe, it, expect, vi } from 'vitest'
import { Address, toNano } from '@ton/core'
import { payTon } from '../../src/drivers/ton/pay.js'
import type { X402AcceptEntry } from '../../src/x402.js'

const PAY_TO = new Address(0, Buffer.alloc(32, 3)).toString()
const SENDER_JW = new Address(0, Buffer.alloc(32, 8))
const USDT_MASTER = 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs'

/** A stub opened-wallet: records sendTransfer args, advances seqno on demand. */
function mockClient() {
  const captured: { args?: any } = {}
  let seqno = 5
  const opened = {
    getSeqno: async () => seqno++, // 5 (payTon), then 6 (waitForSeqno → advanced)
    sendTransfer: async (args: any) => {
      captured.args = args
    },
  }
  const client = { open: () => opened }
  return { client, captured }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const wallet = {
  keyPair: { publicKey: Buffer.alloc(32), secretKey: Buffer.alloc(64) },
  contract: { address: new Address(0, Buffer.alloc(32, 1)) },
} as any

function jettonAccept(amount: string, nonce = 'test-nonce'): X402AcceptEntry {
  return {
    scheme: 'onchain-proof',
    network: 'tvm:-239',
    amount,
    asset: USDT_MASTER,
    payTo: PAY_TO,
    maxTimeoutSeconds: 600,
    extra: { nonce, decimals: 6, minConfirmations: 1, amountFormatted: '0.05' },
  }
}

/** Run payTon to completion, skipping the real seqno-poll delay. */
async function runPay(client: any, accept: X402AcceptEntry, senderJettonWallet?: Address) {
  vi.useFakeTimers()
  try {
    const p = payTon({ client, wallet, accept, senderJettonWallet })
    await vi.runAllTimersAsync()
    await p
  } finally {
    vi.useRealTimers()
  }
}

describe('payTon — jetton transfer (USD₮)', () => {
  it('sends a TEP-74 transfer to our jetton wallet with the nonce as forward comment', async () => {
    const { client, captured } = mockClient()
    await runPay(client, jettonAccept('50000'), SENDER_JW)

    const msg = captured.args.messages[0]
    // routed to OUR jetton wallet, with ~0.05 TON gas, bounceable
    expect(msg.info.dest.equals(SENDER_JW)).toBe(true)
    expect(msg.info.value.coins).toBe(toNano('0.05'))
    expect(msg.info.bounce).toBe(true)

    // body parses as a correct op::transfer (0x0f8a7ea5)
    const s = msg.body.beginParse()
    expect(s.loadUint(32)).toBe(0x0f8a7ea5)
    s.loadUintBig(64) // query_id
    expect(s.loadCoins()).toBe(50000n) // amount (base units)
    expect(s.loadAddress().equals(Address.parse(PAY_TO))).toBe(true) // destination owner
    s.loadAddress() // response_destination
    expect(s.loadBit()).toBe(false) // no custom_payload
    expect(s.loadCoins()).toBe(1n) // forward_ton_amount
    expect(s.loadBit()).toBe(true) // forward_payload in a ref
    const fwd = s.loadRef().beginParse()
    expect(fwd.loadUint(32)).toBe(0) // text-comment op
    expect(fwd.loadStringTail()).toBe('test-nonce') // the challenge nonce

    // signed with our key, gas paid separately
    expect(captured.args.secretKey).toBe(wallet.keyPair.secretKey)
    expect(captured.args.seqno).toBe(5)
  })
})

describe('payTon — native TON', () => {
  it('sends one internal message to payTo carrying the value + comment', async () => {
    const { client, captured } = mockClient()
    const accept = { ...jettonAccept('1000000000'), asset: 'native', extra: { ...jettonAccept('1').extra, decimals: 9 } }
    await runPay(client, accept)

    const msg = captured.args.messages[0]
    expect(msg.info.dest.equals(Address.parse(PAY_TO))).toBe(true)
    expect(msg.info.value.coins).toBe(1000000000n) // 1 TON
    expect(msg.info.bounce).toBe(false)

    const s = msg.body.beginParse()
    expect(s.loadUint(32)).toBe(0) // text-comment op
    expect(s.loadStringTail()).toBe('test-nonce')
  })
})

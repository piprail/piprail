import { describe, it, expect } from 'vitest'
import algosdk from 'algosdk'
import { payAlgorand, type AlgorandPayClient, type AlgorandTransfer } from '../../src/drivers/algorand/pay.js'
import { InsufficientFundsError, RecipientNotReadyError } from '../../src/errors.js'
import type { X402AcceptEntry } from '../../src/x402.js'

const PAY_TO = algosdk.generateAccount().addr.toString()
const SK = algosdk.generateAccount().sk

interface Captured {
  transfer?: AlgorandTransfer
  signed?: boolean
}

function mockClient(opts?: { signSendThrows?: Error }) {
  const captured: Captured = {}
  const client: AlgorandPayClient = {
    async build(transfer) {
      captured.transfer = transfer
      return { txn: { __raw: true }, txId: 'ALGOTXID123' }
    },
    async signSend() {
      if (opts?.signSendThrows) throw opts.signSendThrows
      captured.signed = true
    },
  }
  return { client, captured }
}

function usdcAccept(asset = '31566704'): X402AcceptEntry {
  return {
    scheme: 'onchain-proof',
    network: 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73k',
    amount: '50000',
    asset,
    payTo: PAY_TO,
    maxTimeoutSeconds: 600,
    extra: { nonce: 'nonce-abc-123', decimals: 6, minConfirmations: 1, amountFormatted: '0.05', symbol: 'USDC' },
  }
}

describe('payAlgorand — builds + submits a note-bound transfer', () => {
  it('builds a USDC asset-transfer with the asset id, amount, recipient, and the nonce in the note', async () => {
    const { client, captured } = mockClient()
    const ref = await payAlgorand({ client, sk: SK, sender: PAY_TO, accept: usdcAccept() })
    expect(ref).toBe('ALGOTXID123')
    expect(captured.signed).toBe(true)
    expect(captured.transfer?.assetId).toBe(31566704)
    expect(captured.transfer?.receiver).toBe(PAY_TO)
    expect(captured.transfer?.amount).toBe(50000n)
    // the challenge nonce rides verbatim in the note (Template A binding)
    expect(new TextDecoder().decode(captured.transfer!.note)).toBe('nonce-abc-123')
  })

  it('native ALGO builds a payment txn (no assetId)', async () => {
    const { client, captured } = mockClient()
    const base = usdcAccept()
    const accept: X402AcceptEntry = {
      ...base,
      asset: 'native',
      amount: '1000000',
      extra: { ...base.extra, symbol: 'ALGO', decimals: 6, amountFormatted: '1' },
    }
    const ref = await payAlgorand({ client, sk: SK, sender: PAY_TO, accept })
    expect(ref).toBe('ALGOTXID123')
    expect(captured.transfer?.assetId).toBeUndefined()
    expect(captured.transfer?.amount).toBe(1000000n)
  })
})

describe('payAlgorand — affordability + recipient setup map to typed errors (ERRORS.md §7)', () => {
  it('a sender "overspend" submit failure → InsufficientFundsError', async () => {
    const { client } = mockClient({ signSendThrows: new Error('TransactionPool.Remember: overspend (account ... balance 0)') })
    await expect(
      payAlgorand({ client, sk: SK, sender: PAY_TO, accept: usdcAccept() })
    ).rejects.toBeInstanceOf(InsufficientFundsError)
  })

  it('a recipient "must optin" submit failure → RecipientNotReadyError', async () => {
    const { client } = mockClient({
      signSendThrows: new Error('TransactionPool.Remember: receiver error: must optin, asset 31566704 missing from ' + PAY_TO),
    })
    await expect(
      payAlgorand({ client, sk: SK, sender: PAY_TO, accept: usdcAccept() })
    ).rejects.toBeInstanceOf(RecipientNotReadyError)
  })
})

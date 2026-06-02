/**
 * ── SOLANA SECTION: pay ──
 * Build, sign, broadcast, and confirm a Solana payment. Native SOL via
 * SystemProgram; SPL tokens via a checked transfer (validates mint + decimals
 * on-chain) with an idempotent ATA-create so the recipient's token account is
 * made if missing. Returns the signature — the proof ref. `connection` is
 * injected so it's testable with a mock.
 */
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  type Connection,
} from '@solana/web3.js'
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token'
import type { X402AcceptEntry } from '../../x402.js'

export interface PaySolanaParams {
  connection: Pick<
    Connection,
    'getLatestBlockhash' | 'sendRawTransaction' | 'confirmTransaction'
  >
  keypair: Keypair
  accept: X402AcceptEntry
}

export async function paySolana(params: PaySolanaParams): Promise<string> {
  const { connection, keypair, accept } = params
  const payTo = new PublicKey(accept.payTo)
  const amount = BigInt(accept.amount)
  const tx = new Transaction()

  if (accept.asset === 'native') {
    tx.add(
      SystemProgram.transfer({
        fromPubkey: keypair.publicKey,
        toPubkey: payTo,
        lamports: amount,
      })
    )
  } else {
    const mint = new PublicKey(accept.asset)
    const source = getAssociatedTokenAddressSync(mint, keypair.publicKey)
    const dest = getAssociatedTokenAddressSync(mint, payTo)
    tx.add(
      createAssociatedTokenAccountIdempotentInstruction(
        keypair.publicKey, // payer for any rent
        dest,
        payTo,
        mint
      )
    )
    tx.add(
      createTransferCheckedInstruction(
        source,
        mint,
        dest,
        keypair.publicKey,
        amount,
        accept.extra.decimals
      )
    )
  }

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash()
  tx.recentBlockhash = blockhash
  tx.lastValidBlockHeight = lastValidBlockHeight
  tx.feePayer = keypair.publicKey
  tx.sign(keypair)

  const signature = await connection.sendRawTransaction(tx.serialize(), {
    maxRetries: 5,
  })
  await connection.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    'confirmed'
  )
  return signature
}

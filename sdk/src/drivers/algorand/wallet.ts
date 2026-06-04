/**
 * ── ALGORAND SECTION: wallet ──
 * Validate + wrap the agent's wallet config (mirrors the other families).
 * Accepts `{ mnemonic }` (a 25-word Algorand recovery phrase) or a ready
 * `{ account }` (an algosdk `{ addr, sk }`). Rejects EVM / Solana / TON / Stellar /
 * XRPL / Tron / Sui / NEAR / Aptos wallet shapes with a clear WrongFamilyError.
 *
 * `mnemonic` is shared with TON by name, but the `chain: 'algorand'` selector
 * routes here and the phrase is validated by `mnemonicToSecretKey` — a 24-word TON
 * mnemonic is the wrong length and surfaces a clear error.
 */
import algosdk from 'algosdk'
import { WrongFamilyError } from '../../errors.js'

/** A resolved Algorand signer — the 58-char address + the 64-byte secret key. */
export interface AlgorandSigner {
  addr: string
  sk: Uint8Array
}

export interface AlgorandWalletConfig {
  /** A 25-word Algorand mnemonic (the account's recovery phrase). */
  mnemonic?: string
  /** A ready algosdk account `{ addr, sk }`, if you built it yourself. */
  account?: { addr: unknown; sk: Uint8Array }
}

/** Sync shape-check (mirrors the other families' wrong-family guard). */
export function assertAlgorandWallet(
  wallet: unknown,
  network: string
): AlgorandWalletConfig {
  if (typeof wallet !== 'object' || wallet === null) {
    throw new WrongFamilyError(
      `chain ${network} is Algorand; wallet must be { mnemonic } (25 words) or { account }.`
    )
  }
  if ('privateKey' in wallet || 'walletClient' in wallet) {
    throw new WrongFamilyError(
      `chain ${network} is Algorand; an EVM/Aptos wallet can't be used — pass { mnemonic } (25 words) or { account }.`
    )
  }
  if (
    'secretKey' in wallet ||
    'signer' in wallet ||
    'secret' in wallet ||
    'keypair' in wallet ||
    'keyPair' in wallet ||
    'seed' in wallet ||
    'accountId' in wallet
  ) {
    throw new WrongFamilyError(
      `chain ${network} is Algorand; that looks like another family's wallet — pass { mnemonic } (25 words) or { account }.`
    )
  }
  if (!('mnemonic' in wallet) && !('account' in wallet)) {
    throw new WrongFamilyError(
      `chain ${network} is Algorand; wallet must be { mnemonic } (25 words) or { account }.`
    )
  }
  return wallet as AlgorandWalletConfig
}

/** Build the signing account from the validated config. */
export function resolveAlgorandWallet(config: AlgorandWalletConfig): AlgorandSigner {
  if (config.account) {
    return { addr: String(config.account.addr), sk: config.account.sk }
  }
  if (config.mnemonic != null) {
    try {
      const { addr, sk } = algosdk.mnemonicToSecretKey(config.mnemonic)
      return { addr: addr.toString(), sk }
    } catch (cause) {
      throw new WrongFamilyError(
        'Algorand wallet { mnemonic } is not a valid 25-word Algorand mnemonic.',
        { cause }
      )
    }
  }
  throw new WrongFamilyError('Algorand wallet needs { mnemonic } (25 words) or { account }.')
}

/**
 * ── STELLAR SECTION: wallet ──
 * Validate + wrap the agent's wallet config (mirrors evm/solana/ton wallet.ts).
 * Accepts `{ secret }` (an S… secret seed) or a ready `{ keypair }`; rejects
 * EVM / Solana / TON wallet shapes with a clear WrongFamilyError.
 *
 * Stellar key derivation is synchronous (`Keypair.fromSecret`), so there's no
 * async step — but we still split `assert` (shape) from `resolve` (build the
 * Keypair) to mirror the other families.
 */
import { Keypair, StrKey } from '@stellar/stellar-sdk'
import { WrongFamilyError } from '../../errors.js'

export interface StellarWalletConfig {
  /** An S… secret seed — the account's private key. */
  secret?: string
  /** A ready @stellar/stellar-sdk Keypair, if you built it yourself. */
  keypair?: Keypair
}

/** Sync shape-check (mirrors the other families' wrong-family guard). */
export function assertStellarWallet(
  wallet: unknown,
  network: string
): StellarWalletConfig {
  if (typeof wallet !== 'object' || wallet === null) {
    throw new WrongFamilyError(
      `chain ${network} is Stellar; wallet must be { secret } (S… seed) or { keypair }.`
    )
  }
  if ('privateKey' in wallet || 'walletClient' in wallet) {
    throw new WrongFamilyError(
      `chain ${network} is Stellar; an EVM wallet can't be used — pass { secret } (S… seed) or { keypair }.`
    )
  }
  if (
    'secretKey' in wallet ||
    'signer' in wallet ||
    'mnemonic' in wallet ||
    'keyPair' in wallet
  ) {
    throw new WrongFamilyError(
      `chain ${network} is Stellar; that looks like a Solana/TON wallet — pass { secret } (S… seed) or { keypair }.`
    )
  }
  if (!('secret' in wallet) && !('keypair' in wallet)) {
    throw new WrongFamilyError(
      `chain ${network} is Stellar; wallet must be { secret } (S… seed) or { keypair }.`
    )
  }
  return wallet as StellarWalletConfig
}

/** Build the signing Keypair from the validated config. */
export function resolveStellarWallet(config: StellarWalletConfig): Keypair {
  if (config.keypair) return config.keypair
  if (config.secret) {
    if (!StrKey.isValidEd25519SecretSeed(config.secret)) {
      throw new WrongFamilyError(
        'Stellar wallet { secret } is not a valid S… secret seed.'
      )
    }
    return Keypair.fromSecret(config.secret)
  }
  throw new WrongFamilyError('Stellar wallet needs { secret } (S… seed) or { keypair }.')
}

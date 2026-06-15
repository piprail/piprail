/**
 * ── STELLAR SECTION: wallet ──
 * Validate + wrap the agent's wallet config (mirrors evm/solana/ton wallet.ts).
 * Accepts `{ key }` (an S… secret seed) or a ready `{ keypair }`; rejects
 * pre-v2 wallet shapes with a clear WrongFamilyError.
 *
 * Stellar key derivation is synchronous (`Keypair.fromSecret`), so there's no
 * async step — but we still split `assert` (shape) from `resolve` (build the
 * Keypair) to mirror the other families.
 */
import { Keypair, StrKey } from '@stellar/stellar-sdk'
import { WrongFamilyError } from '../../errors.js'
import { assertNoLegacyWalletKey } from '../wallet-migrate.js'

export interface StellarWalletConfig {
  /** An S… secret seed — the account's private key. */
  key?: string
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
      `chain ${network} is Stellar; wallet must be { key } (S… seed) or { keypair }.`
    )
  }
  assertNoLegacyWalletKey(wallet, 'Stellar')
  if (!('key' in wallet) && !('keypair' in wallet)) {
    throw new WrongFamilyError(
      `chain ${network} is Stellar; wallet must be { key } (S… seed) or { keypair }.`
    )
  }
  return wallet as StellarWalletConfig
}

/** Build the signing Keypair from the validated config. */
export function resolveStellarWallet(config: StellarWalletConfig): Keypair {
  if (config.keypair) return config.keypair
  if (config.key) {
    if (!StrKey.isValidEd25519SecretSeed(config.key)) {
      throw new WrongFamilyError('Stellar wallet { key } is not a valid S… secret seed.')
    }
    return Keypair.fromSecret(config.key)
  }
  throw new WrongFamilyError('Stellar wallet needs { key } (S… seed) or { keypair }.')
}

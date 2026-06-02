/**
 * ── SUI SECTION: wallet ──
 * Validate + wrap the agent's wallet config (mirrors the other families).
 * Accepts `{ privateKey }` (a `suiprivkey1…` bech32 secret, or a raw 32-byte
 * Uint8Array) or a ready `{ keypair }` (an Ed25519Keypair). Rejects EVM / Solana
 * / TON / Stellar / XRPL / NEAR wallet shapes with a clear WrongFamilyError.
 *
 * `privateKey` is shared with EVM/Tron by name, but the `chain: 'sui'` selector
 * routes here and the bech32/byte format is validated by Ed25519Keypair — a hex
 * `0x…` EVM key won't parse and surfaces a clear error.
 */
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import { WrongFamilyError } from '../../errors.js'

export interface SuiWalletConfig {
  /** A `suiprivkey1…` bech32 secret, or the raw 32-byte secret. */
  privateKey?: string | Uint8Array
  /** A ready @mysten/sui Ed25519Keypair, if you built it yourself. */
  keypair?: Ed25519Keypair
}

/** Sync shape-check (mirrors the other families' wrong-family guard). */
export function assertSuiWallet(wallet: unknown, network: string): SuiWalletConfig {
  if (typeof wallet !== 'object' || wallet === null) {
    throw new WrongFamilyError(
      `chain ${network} is Sui; wallet must be { privateKey } (suiprivkey1… ) or { keypair }.`
    )
  }
  if ('walletClient' in wallet) {
    throw new WrongFamilyError(
      `chain ${network} is Sui; a viem { walletClient } can't be used — pass { privateKey } (suiprivkey1…) or { keypair }.`
    )
  }
  if (
    'secretKey' in wallet ||
    'signer' in wallet ||
    'mnemonic' in wallet ||
    'keyPair' in wallet ||
    'secret' in wallet ||
    'seed' in wallet ||
    'accountId' in wallet
  ) {
    throw new WrongFamilyError(
      `chain ${network} is Sui; that looks like another family's wallet — pass { privateKey } (suiprivkey1…) or { keypair }.`
    )
  }
  if (!('privateKey' in wallet) && !('keypair' in wallet)) {
    throw new WrongFamilyError(
      `chain ${network} is Sui; wallet must be { privateKey } (suiprivkey1…) or { keypair }.`
    )
  }
  return wallet as SuiWalletConfig
}

/** Build the signing Ed25519Keypair from the validated config. */
export function resolveSuiKeypair(config: SuiWalletConfig): Ed25519Keypair {
  if (config.keypair) return config.keypair
  if (config.privateKey != null) {
    try {
      return Ed25519Keypair.fromSecretKey(config.privateKey)
    } catch (cause) {
      throw new WrongFamilyError(
        'Sui wallet { privateKey } is not a valid suiprivkey1… secret (or 32-byte key).',
        { cause }
      )
    }
  }
  throw new WrongFamilyError('Sui wallet needs { privateKey } (suiprivkey1…) or { keypair }.')
}

/**
 * ── NEAR SECTION: wallet ──
 * Validate + wrap the agent's wallet config. NEAR signing needs BOTH an account
 * id and a key, so the config is `{ accountId, privateKey }` — `privateKey` is an
 * `ed25519:…` secret key string. The presence of `accountId` is what
 * distinguishes a NEAR wallet from EVM/Tron/Sui `{ privateKey }`. Rejects the
 * other families' shapes with a clear WrongFamilyError.
 *
 * Shape is checked synchronously; the signer is built in `resolveNearWallet`.
 */
import { KeyPairSigner } from 'near-api-js'
import type { Signer } from 'near-api-js'
import { WrongFamilyError } from '../../errors.js'

export interface NearWalletConfig {
  /** The signing account id (named `*.near` or a 64-hex implicit account). */
  accountId?: string
  /** An `ed25519:…` secret key string. */
  privateKey?: string
}

export interface NearWallet {
  accountId: string
  signer: Signer
}

/** Sync shape-check (mirrors the other families' wrong-family guard). */
export function assertNearWallet(wallet: unknown, network: string): NearWalletConfig {
  if (typeof wallet !== 'object' || wallet === null) {
    throw new WrongFamilyError(
      `chain ${network} is NEAR; wallet must be { accountId, privateKey } (privateKey = ed25519:…).`
    )
  }
  if ('walletClient' in wallet) {
    throw new WrongFamilyError(
      `chain ${network} is NEAR; a viem { walletClient } can't be used — pass { accountId, privateKey }.`
    )
  }
  if (
    'secretKey' in wallet ||
    'signer' in wallet ||
    'mnemonic' in wallet ||
    'keyPair' in wallet ||
    'secret' in wallet ||
    'seed' in wallet ||
    'keypair' in wallet
  ) {
    throw new WrongFamilyError(
      `chain ${network} is NEAR; that looks like another family's wallet — pass { accountId, privateKey }.`
    )
  }
  if (!('accountId' in wallet) || !('privateKey' in wallet)) {
    throw new WrongFamilyError(
      `chain ${network} is NEAR; wallet must be { accountId, privateKey } (privateKey = ed25519:…).`
    )
  }
  return wallet as NearWalletConfig
}

/** Build the { accountId, signer } from the validated config. */
export function resolveNearWallet(config: NearWalletConfig): NearWallet {
  if (!config.accountId || !config.privateKey) {
    throw new WrongFamilyError('NEAR wallet needs { accountId, privateKey } (privateKey = ed25519:…).')
  }
  let signer: Signer
  try {
    signer = KeyPairSigner.fromSecretKey(config.privateKey as `ed25519:${string}`)
  } catch (cause) {
    throw new WrongFamilyError('NEAR wallet { privateKey } is not a valid ed25519:… secret key.', {
      cause,
    })
  }
  return { accountId: config.accountId, signer }
}

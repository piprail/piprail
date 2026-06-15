/**
 * ── NEAR SECTION: wallet ──
 * Validate + wrap the agent's wallet config. NEAR signing needs BOTH an account
 * id and a key, so the config is `{ accountId, key }` — `key` is an `ed25519:…`
 * secret key string. NEAR is the one family that keeps a second field, since an
 * account id can't be derived from the key. Rejects pre-v2 shapes with a clear
 * WrongFamilyError.
 *
 * Shape is checked synchronously; the signer is built in `resolveNearWallet`.
 */
import { KeyPairSigner } from 'near-api-js'
import type { Signer } from 'near-api-js'
import { WrongFamilyError } from '../../errors.js'
import { assertNoLegacyWalletKey } from '../wallet-migrate.js'

export interface NearWalletConfig {
  /** The signing account id (named `*.near` or a 64-hex implicit account). */
  accountId?: string
  /** An `ed25519:…` secret key string. */
  key?: string
}

export interface NearWallet {
  accountId: string
  signer: Signer
}

/** Sync shape-check (mirrors the other families' wrong-family guard). */
export function assertNearWallet(wallet: unknown, network: string): NearWalletConfig {
  if (typeof wallet !== 'object' || wallet === null) {
    throw new WrongFamilyError(
      `chain ${network} is NEAR; wallet must be { accountId, key } (key = ed25519:…).`
    )
  }
  assertNoLegacyWalletKey(wallet, 'NEAR')
  if (!('accountId' in wallet) || !('key' in wallet)) {
    throw new WrongFamilyError(
      `chain ${network} is NEAR; wallet must be { accountId, key } (key = ed25519:…).`
    )
  }
  return wallet as NearWalletConfig
}

/** Build the { accountId, signer } from the validated config. */
export function resolveNearWallet(config: NearWalletConfig): NearWallet {
  if (!config.accountId || !config.key) {
    throw new WrongFamilyError('NEAR wallet needs { accountId, key } (key = ed25519:…).')
  }
  let signer: Signer
  try {
    signer = KeyPairSigner.fromSecretKey(config.key as `ed25519:${string}`)
  } catch (cause) {
    throw new WrongFamilyError('NEAR wallet { key } is not a valid ed25519:… secret key.', {
      cause,
    })
  }
  return { accountId: config.accountId, signer }
}

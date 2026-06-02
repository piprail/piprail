/**
 * ── TRON SECTION: wallet ──
 * Validate + wrap the agent's wallet config (mirrors evm/solana/ton/stellar
 * wallet.ts). Accepts `{ privateKey }` — a 32-byte hex key (Tron uses secp256k1,
 * so the key format is the same as EVM); the `chain: 'tron'` selector is what
 * routes here, and `assertValidPayTo` is what catches an EVM/Tron address mixup.
 * Rejects Solana / TON / Stellar / XRPL wallet shapes, and EVM's `{ walletClient }`
 * (viem-specific), with a clear WrongFamilyError.
 *
 * Validation is synchronous; signing happens in pay.ts via the injected client.
 */
import { WrongFamilyError } from '../../errors.js'

export interface TronWalletConfig {
  /** A 32-byte private key, hex (with or without the 0x prefix). */
  privateKey?: string
}

/** Sync shape-check (mirrors the other families' wrong-family guard). */
export function assertTronWallet(wallet: unknown, network: string): TronWalletConfig {
  if (typeof wallet !== 'object' || wallet === null) {
    throw new WrongFamilyError(
      `chain ${network} is Tron; wallet must be { privateKey } (32-byte hex).`
    )
  }
  if ('walletClient' in wallet) {
    throw new WrongFamilyError(
      `chain ${network} is Tron; a viem { walletClient } can't be used — pass { privateKey } (32-byte hex).`
    )
  }
  if (
    'secretKey' in wallet ||
    'signer' in wallet ||
    'mnemonic' in wallet ||
    'keyPair' in wallet ||
    'secret' in wallet ||
    'keypair' in wallet ||
    'seed' in wallet
  ) {
    throw new WrongFamilyError(
      `chain ${network} is Tron; that looks like a Solana/TON/Stellar/XRPL wallet — pass { privateKey } (32-byte hex).`
    )
  }
  if (!('privateKey' in wallet)) {
    throw new WrongFamilyError(
      `chain ${network} is Tron; wallet must be { privateKey } (32-byte hex).`
    )
  }
  return wallet as TronWalletConfig
}

/** Validate + normalise the private key to bare lowercase hex (no 0x). */
export function resolveTronPrivateKey(config: TronWalletConfig): string {
  if (!config.privateKey) {
    throw new WrongFamilyError('Tron wallet needs { privateKey } (32-byte hex).')
  }
  const hex = config.privateKey.replace(/^0x/i, '').toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new WrongFamilyError(
      'Tron wallet { privateKey } must be a 32-byte hex string (64 hex chars).'
    )
  }
  return hex
}

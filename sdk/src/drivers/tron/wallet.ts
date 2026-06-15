/**
 * ── TRON SECTION: wallet ──
 * Validate + wrap the agent's wallet config (mirrors evm/solana/ton/stellar
 * wallet.ts). Accepts `{ key }` — a 32-byte hex private key (Tron uses secp256k1,
 * so the key format is the same as EVM); the `chain: 'tron'` selector is what
 * routes here, and `assertValidPayTo` is what catches an EVM/Tron address mixup.
 * Rejects pre-v2 wallet shapes with a clear WrongFamilyError.
 *
 * Validation is synchronous; signing happens in pay.ts via the injected client.
 */
import { WrongFamilyError } from '../../errors.js'
import { assertNoLegacyWalletKey } from '../wallet-migrate.js'

export interface TronWalletConfig {
  /** A 32-byte private key, hex (with or without the 0x prefix). */
  key?: string
}

/** Sync shape-check (mirrors the other families' wrong-family guard). */
export function assertTronWallet(wallet: unknown, network: string): TronWalletConfig {
  if (typeof wallet !== 'object' || wallet === null) {
    throw new WrongFamilyError(
      `chain ${network} is Tron; wallet must be { key } (32-byte hex).`
    )
  }
  assertNoLegacyWalletKey(wallet, 'Tron')
  if (!('key' in wallet)) {
    throw new WrongFamilyError(
      `chain ${network} is Tron; wallet must be { key } (32-byte hex).`
    )
  }
  return wallet as TronWalletConfig
}

/** Validate + normalise the private key to bare lowercase hex (no 0x). */
export function resolveTronPrivateKey(config: TronWalletConfig): string {
  if (!config.key) {
    throw new WrongFamilyError('Tron wallet needs { key } (32-byte hex).')
  }
  const hex = config.key.replace(/^0x/i, '').toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new WrongFamilyError(
      'Tron wallet { key } must be a 32-byte hex string (64 hex chars).'
    )
  }
  return hex
}

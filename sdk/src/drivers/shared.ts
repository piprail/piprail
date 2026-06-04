/**
 * Cross-driver helpers every family's `index.ts` reuses, so the wrong-family
 * token guard reads and behaves identically on every chain — and a new family
 * is auto-covered the moment it's added to the maps below. Chain-agnostic:
 * imports only `errors.js` + types, so it stays free of any chain SDK.
 */
import { WrongFamilyError } from '../errors.js'
import type { ChainFamily } from './types.js'

/** Human label per family, for error messages. */
const FAMILY_LABEL: Record<ChainFamily, string> = {
  evm: 'EVM',
  solana: 'Solana',
  ton: 'TON',
  stellar: 'Stellar',
  xrpl: 'XRPL',
  tron: 'Tron',
  sui: 'Sui',
  near: 'NEAR',
  aptos: 'Aptos',
  algorand: 'Algorand',
}

/**
 * Each family's object-token discriminant + how to describe / pass it. The `key`
 * is the field whose PRESENCE identifies that family's token shape, so it must be
 * chosen to NOT appear in another family's token — e.g. Stellar uses `code` (not
 * `issuer`, which XRPL tokens also carry). EVM and Tron both legitimately use
 * `address` (a contract address); that shared key is handled in
 * {@link rejectForeignToken} (a shape two families share isn't "foreign").
 */
const FAMILY_TOKEN: Record<ChainFamily, { key: string; shape: string; hint: string }> = {
  evm: { key: 'address', shape: '{ address }', hint: '{ address, decimals }' },
  solana: { key: 'mint', shape: '{ mint }', hint: '{ mint, decimals }' },
  ton: { key: 'master', shape: '{ master }', hint: '{ master, decimals }' },
  stellar: { key: 'code', shape: '{ issuer, code }', hint: '{ issuer, code, decimals }' },
  xrpl: { key: 'currencyHex', shape: '{ issuer, currencyHex }', hint: '{ issuer, currencyHex, decimals }' },
  tron: { key: 'address', shape: '{ address }', hint: '{ address, decimals }' },
  sui: { key: 'coinType', shape: '{ coinType }', hint: '{ coinType, decimals }' },
  near: { key: 'contractId', shape: '{ contractId }', hint: '{ contractId, decimals }' },
  aptos: { key: 'metadata', shape: '{ metadata }', hint: '{ metadata, decimals }' },
  algorand: { key: 'assetId', shape: '{ assetId }', hint: '{ assetId, decimals }' },
}

/**
 * Throw a uniform {@link WrongFamilyError} if `token` is an object carrying a
 * DIFFERENT family's discriminant (e.g. a `{ mint }` token on a Stellar chain).
 * Call it in `resolveToken` after handling `'native'` + the symbol case, before
 * reading your own token fields. Driver-agnostic, so every chain's cross-family
 * message is identical by construction (and adding a family updates all of them
 * at once).
 */
export function rejectForeignToken(
  token: object,
  family: ChainFamily,
  network: string
): void {
  const own = FAMILY_TOKEN[family]
  for (const fam of Object.keys(FAMILY_TOKEN) as ChainFamily[]) {
    if (fam === family) continue
    // A discriminant this family ALSO uses (EVM ↔ Tron both use `address`) isn't
    // a foreign shape — skip it; the address VALUE + format check distinguishes
    // the chain (an 0x… vs T… address is caught by the driver's own validation).
    if (FAMILY_TOKEN[fam].key === own.key) continue
    if (FAMILY_TOKEN[fam].key in token) {
      throw new WrongFamilyError(
        `chain ${network} is ${FAMILY_LABEL[family]}; a ${FAMILY_LABEL[fam]} ` +
          `${FAMILY_TOKEN[fam].shape} token can't be used — pass ${own.hint}.`
      )
    }
  }
}

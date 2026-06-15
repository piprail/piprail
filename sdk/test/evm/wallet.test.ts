import { describe, it, expect } from 'vitest'
import { WrongFamilyError } from '../../src/index.js'
import { evmDriver } from '../../src/drivers/evm/index.js'

describe('EVM wallet binding (createWalletAdapter) — typed errors for a bad { key }', () => {
  const net = evmDriver.resolve({ chain: 'base' })!
  const VALID = `0x${'11'.repeat(64 / 2)}` // 0x + 64 hex chars

  it('accepts a valid 0x… 32-byte hex { key }', () => {
    expect(() => net.bindWallet({ key: VALID })).not.toThrow()
  })

  it('rejects a malformed / wrong-family { key } with a typed WrongFamilyError (never a raw viem leak)', () => {
    for (const bad of ['xyz', '', '0x1234', `0x${'z'.repeat(64)}`, 'not-a-hex-key', 'aBase58LookingSecretNo0x']) {
      let err: any
      try {
        net.bindWallet({ key: bad })
      } catch (e) {
        err = e
      }
      expect(err, `key=${JSON.stringify(bad)} should reject`).toBeInstanceOf(WrongFamilyError)
      expect(err.code).toBe('WRONG_FAMILY')
      expect(err.message).toMatch(/EVM/)
      // the raw viem message must NOT leak
      expect(err.message).not.toMatch(/invalid private key, expected hex/)
    }
  })

  it('hints when a non-0x (base58/seed) key is passed — likely a wrong-family mistake', () => {
    let err: any
    try {
      net.bindWallet({ key: 'aBase58LookingSecretNo0x' })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(WrongFamilyError)
    expect(err.message).toMatch(/another family/)
  })

  it('rejects pre-v2 legacy wallet fields with a migration WrongFamilyError', () => {
    expect(() => net.bindWallet({ privateKey: VALID })).toThrow(/EVM/)
    expect(() => net.bindWallet({ secretKey: new Uint8Array(64) })).toThrow(/EVM/)
  })
})

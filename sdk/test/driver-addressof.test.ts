/**
 * ── `addressOf` — the answer to "where do I get paid?" ──────────────────────────────
 *
 * The highest-consequence read in the SDK. `piprail_sell` defaults an offer's `payTo` to it, so
 * a family that derives the wrong string does not throw or warn: the agent simply advertises an
 * address that is not its own and sends its income somewhere it cannot spend from.
 *
 * It was added to all ten families in one change and, for a while, only two of them were ever
 * checked against a real wallet. Verified against ground truth (the recorded address in each
 * funded test wallet) it came back 9/10, and the one that was wrong is pinned below.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = (p: string) => readFileSync(join(import.meta.dirname, '..', 'src', p), 'utf8')

const FAMILIES = ['evm', 'solana', 'ton', 'stellar', 'xrpl', 'tron', 'near', 'sui', 'aptos', 'algorand']

describe('every family answers "where do I get paid?"', () => {
  it('implements addressOf, in all ten', () => {
    for (const f of FAMILIES) {
      expect(src(`drivers/${f}/index.ts`), `${f} has no addressOf`).toMatch(/async addressOf\(/)
    }
  })

  it('derives it from the KEY, never from an RPC read', () => {
    /*
     * `address()` is documented as pure, and `piprail_sell` calls it on every offer. A family
     * that reached for the network here would make selling fail whenever an RPC was rate-limited,
     * and would do it at the worst moment: while pricing something.
     */
    for (const f of FAMILIES) {
      const body = src(`drivers/${f}/index.ts`).match(/async addressOf\([\s\S]*?\n    \},/)?.[0] ?? ''
      expect(body, `${f} addressOf is empty`).not.toBe('')
      expect(body, `${f} addressOf reads the chain`).not.toMatch(/getBalance|getAccount|readContract|accountInformation|loadAccount|\brpc\(/)
    }
  })

  it('🔴 TON returns the NON-BOUNCEABLE form, or a new seller’s first payment bounces', () => {
    /*
     * TON encodes one account two ways. `toString()` defaults to BOUNCEABLE (`EQ…`), which
     * returns funds to the sender when the destination contract is not yet initialised — and a
     * wallet contract is uninitialised until it has sent its first transaction. A freshly
     * generated agent advertising `EQ…` would therefore bounce the very first payment it was
     * ever sent. `UQ…` is also what TON wallets display as the receive address.
     *
     * Caught by checking all ten families against the address recorded in each wallet file:
     * TON was the one mismatch (derived EQDw-kZ1s…, recorded UQDw-kZ1s…, same account).
     */
    const body = src('drivers/ton/index.ts').match(/async addressOf\([\s\S]*?\n    \},/)?.[0] ?? ''
    expect(body).toMatch(/bounceable:\s*false/)
  })
})

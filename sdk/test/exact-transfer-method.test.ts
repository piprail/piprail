/**
 * The `exact` transfer-method contract — the single field that made 91% of the x402 web
 * unpayable, locked from every angle.
 *
 * The rule, in one line: **absent means the scheme default; a value we don't implement means
 * skip; nothing else is ever inferred.**
 *
 * Why it needs a file of its own. `extra.assetTransferMethod` is OPTIONAL on the wire —
 * `scheme_exact_evm.md` says *"if no assetTransferMethod is specified in PaymentRequired.extra,
 * clients should default to eip3009"*, and the SVM / Algorand / Aptos / NEAR / Hedera schemes
 * never define the key at all. PipRail required it, so `planPayment` reported "no compatible
 * accept" for every Solana rail, every Arbitrum rail and 85% of Base — with 1,636 green tests,
 * because every fixture in the suite was built by our own gate, which always emits it.
 *
 * Two failure modes have to stay closed at once, and they pull in opposite directions:
 *   • too strict → we reject rails we can pay (the bug above);
 *   • too loose → we sign an EIP-3009 authorization for a rail whose facilitator expects some
 *     other mechanism entirely. It would be refused, but we'd have handed a stranger a signature
 *     for a mechanism we never inspected.
 */
import { describe, it, expect } from 'vitest'
import {
  exactTransferMethod,
  isSettleableExactMethod,
  KNOWN_EXACT_TRANSFER_METHODS,
  DEFAULT_EXACT_TRANSFER_METHOD,
  type X402ExactAcceptEntry,
} from '../src/index.js'

/** A rail carrying just the method under test — the other fields are irrelevant here. */
const rail = (method?: unknown): X402ExactAcceptEntry =>
  ({
    scheme: 'exact',
    ...(method === 'NO_EXTRA' ? {} : { extra: { assetTransferMethod: method } }),
  }) as unknown as X402ExactAcceptEntry

describe('an ABSENT method means the scheme default, never "unknown"', () => {
  it('a rail with no `extra` block at all defaults to eip3009 and is settleable', () => {
    expect(exactTransferMethod(rail('NO_EXTRA'))).toBe('eip3009')
    expect(isSettleableExactMethod(rail('NO_EXTRA'))).toBe(true)
  })

  it('`extra: {}` and an explicit `undefined` behave identically', () => {
    expect(exactTransferMethod({ scheme: 'exact', extra: {} } as X402ExactAcceptEntry)).toBe('eip3009')
    expect(exactTransferMethod(rail(undefined))).toBe('eip3009')
    expect(isSettleableExactMethod(rail(undefined))).toBe(true)
  })

  it('a JSON `null` counts as absent — `null` is what a serializer writes for "no value"', () => {
    expect(exactTransferMethod(rail(null))).toBe('eip3009')
    expect(isSettleableExactMethod(rail(null))).toBe(true)
  })

  it('the exported default IS the spec default', () => {
    expect(DEFAULT_EXACT_TRANSFER_METHOD).toBe('eip3009')
    expect(KNOWN_EXACT_TRANSFER_METHODS.has(DEFAULT_EXACT_TRANSFER_METHOD)).toBe(true)
  })
})

describe('a method we do NOT implement is skipped, never signed blind', () => {
  it('the spec lists erc7710, we do not implement it → not settleable', () => {
    expect(isSettleableExactMethod(rail('erc7710'))).toBe(false)
  })

  it('a method invented after this release is skipped, not guessed at', () => {
    expect(isSettleableExactMethod(rail('some-future-scheme-2029'))).toBe(false)
  })

  it('an EMPTY STRING is a stated value, not an absent one → skipped', () => {
    // `?? ` only catches null/undefined, and that is the behaviour we want: a server that
    // explicitly wrote "" has said something we can't act on, so we don't guess eip3009 for it.
    expect(exactTransferMethod(rail(''))).toBe('')
    expect(isSettleableExactMethod(rail(''))).toBe(false)
  })

  it('the match is CASE-SENSITIVE — the spec writes these lowercase', () => {
    // Accepting `EIP3009` would mean guessing about a server that is already off-spec somewhere.
    expect(isSettleableExactMethod(rail('EIP3009'))).toBe(false)
    expect(isSettleableExactMethod(rail('Permit2'))).toBe(false)
  })

  it('a non-string value cannot crash the predicate or sneak through', () => {
    for (const junk of [123, true, {}, [], { toString: () => 'eip3009' }]) {
      expect(isSettleableExactMethod(rail(junk))).toBe(false)
    }
  })
})

describe('the methods we DO implement', () => {
  it('every literal in the known set is settleable when stated', () => {
    for (const m of KNOWN_EXACT_TRANSFER_METHODS) {
      expect(isSettleableExactMethod(rail(m))).toBe(true)
      expect(exactTransferMethod(rail(m))).toBe(m)
    }
  })

  it('covers the EVM pair plus the foreign dialect, and one literal per non-EVM family', () => {
    // Locked as an exact set: adding a literal here without teaching a driver to sign it would
    // make the gather offer a rail that throws at pay time — the class of bug this file exists
    // for. Removing one silently un-pays every rail that names it.
    expect([...KNOWN_EXACT_TRANSFER_METHODS].sort()).toEqual([
      'algorand',
      'aptos',
      'eip3009',
      'near',
      'permit2',
      'permit2-exact', // Binance b402's foreign-dialect spelling of `permit2`
      'svm',
    ])
  })
})

describe('the per-family default (what a rail that names nothing actually means)', () => {
  /*
   * Only the EVM scheme writes a default down. The other four define no `assetTransferMethod` at
   * all — because each family has exactly ONE mechanism, so the family IS the answer. This is
   * reporting only (`PayOption.method`); routing is each driver's own job.
   */
  it('each exact-capable family reports its own mechanism, never EVM eip3009', () => {
    expect(exactTransferMethod(rail('NO_EXTRA'), 'evm')).toBe('eip3009')
    expect(exactTransferMethod(rail('NO_EXTRA'), 'solana')).toBe('svm')
    expect(exactTransferMethod(rail('NO_EXTRA'), 'algorand')).toBe('algorand')
    expect(exactTransferMethod(rail('NO_EXTRA'), 'aptos')).toBe('aptos')
    expect(exactTransferMethod(rail('NO_EXTRA'), 'near')).toBe('near')
  })

  /*
   * THE STAGE-04 TRIPWIRE. Every non-EVM literal in the known set must be reachable as some
   * family default. Add `xrpl` to the known set (stage 04's XRPL exact buyer) without teaching
   * the family map about it and this fails — otherwise an XRPL rail would quietly report
   * `eip3009 (default)`, naming a mechanism that family cannot sign.
   */
  it('every non-EVM method in the known set is some family default', () => {
    const EVM_METHODS = new Set(['eip3009', 'permit2', 'permit2-exact'])
    const FAMILIES = ['evm', 'solana', 'algorand', 'aptos', 'near', 'ton', 'tron', 'sui', 'stellar', 'xrpl']
    const reachable = new Set(FAMILIES.map((f) => exactTransferMethod(rail('NO_EXTRA'), f)))
    const orphaned = [...KNOWN_EXACT_TRANSFER_METHODS].filter(
      (m) => !EVM_METHODS.has(m) && !reachable.has(m)
    )
    expect(orphaned).toEqual([])
  })

  it('a STATED method always wins over the family default', () => {
    // A Solana rail that explicitly says `svm` reports `svm`; one that says something else
    // reports that, so the skip decision above sees the truth.
    expect(exactTransferMethod(rail('svm'), 'solana')).toBe('svm')
    expect(exactTransferMethod(rail('permit2'), 'evm')).toBe('permit2')
    expect(exactTransferMethod(rail('erc7710'), 'evm')).toBe('erc7710')
  })

  it('an unknown family falls back to the EVM default rather than throwing', () => {
    // `isSettleableExactMethod` calls this WITHOUT a family, so the fallback has to be the one
    // value that keeps an absent marker settleable. Never a crash on a family we don't know.
    expect(exactTransferMethod(rail('NO_EXTRA'), 'not-a-family')).toBe('eip3009')
    expect(exactTransferMethod(rail('NO_EXTRA'), '')).toBe('eip3009')
  })
})

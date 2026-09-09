# The testing protocol: sections, in order

**Read this before a release, after touching the money path, and any time somebody asks
"is it actually working?"** It is the order to test in, why that order, and what each layer
can and cannot tell you.

The whole point is that a red run should name the **subsystem**, not the SDK. One number over
2,000 tests tells you something broke; it does not tell you swaps broke.

---

## The five layers, cheapest first

| Layer | Command | Cost | Answers |
|---|---|---|---|
| **L0** package | `npm run smoke -- --list` is not it; see below | seconds | does npm hand a user a working thing? |
| **L1** unit | `npm run sweep` | ~30s, free | does the code do what its contract says? |
| **L2** adversarial | `npm run smoke -- --layer L2` | seconds, free | what does a **hostile caller** get? |
| **L3** reality | `npm run smoke -- --layer L3` | ~1 min, free | is what we **advertise** still true of the world? |
| **L4** money | `npm run smoke -- --money` | minutes, **spends** | does a payment actually **settle**? |

L0 is folded into L1's `package` checks and the `verify-gate`. L2–L4 live in `scripts/smoke/`.

```bash
npm run sweep                    # L1, all 12 unit sections
npm run sweep -- swaps gate      # L1, one subsystem
npm run smoke                    # L2 + L3 (safe: nothing is spent)
npm run smoke -- --money         # everything, including real mainnet payments
npm run smoke -- gate modes      # named sections only
npm run smoke -- --list          # what exists, and why each section exists
npm run smoke -- --each          # AUDIT: every section on its own, plus a matrix
```

---

## 🔴 The ordering rules

These are the reason the layers exist at all. Breaking them wastes money and produces
confident, wrong conclusions.

**1. Cheapest first, always.** Never spend money to find a bug a free test would have caught.
A `maxPerSwap` typo should fail in L2 in 40ms, not in L4 after a mainnet swap.

**2. A layer is only meaningful if the one before it is green.** If L2 says the gate
double-spends, then of course L4 disagrees with the chain: the code is broken, so every later
result is noise. `npm run smoke` **stops at the first failing layer** for exactly this reason
(`--keep-going` overrides when you are deliberately surveying).

**3. Read-only before write.** L3 asks the world questions. L4 changes it. Anything L3 can
refute — a dead facilitator, a DEX that stopped routing, a token address that moved — should be
refuted before a single transaction is signed.

**4. L2 red and L3 red mean different things.**
   - **L2 red = we broke something.** The code contradicts its own contract. Fix the code.
   - **L3 red = the world changed.** A third party went down, dropped a chain, or changed its
     API. Usually the fix is a registry update or a timeout, not a logic change. Check whether
     the host is *actually* dead before concluding it is — a cold serverless facilitator took
     8.5s to answer once, and an 8s timeout called it dead.

**5. L4 proves one chain, never a family.** A green Solana payment says nothing about Aptos.
Coverage comes from the matrix in `l4-payments.mjs`, not from one happy path.

**6. A green L1 with a red L2 is the normal shape of a real bug.** Unit tests assert what the
code does; L2 asserts what an attacker gets. Every serious bug found in this repo so far lived
in that gap: the replay race, the cross-offer replay, the budget leak. If L2 has nothing to say
about a subsystem, that subsystem is untested where it matters most.

---

## The sections

### L1 — unit (`npm run sweep`)

Twelve sections over the vitest suite. Every suite belongs to **exactly one**: a suite in none
is never swept, one in two is counted twice, and the runner fails on either. The
`sweep-covers-tests` rule enforces the same thing in `npm run sync`, so a new test file that
nobody assigned fails the build.

`wire · gate · client · policy · agent · swaps · facilitators · chains · drivers · discovery ·
transports · adversarial`

### L2 — adversarial (`scripts/smoke/l2-*.mjs`)

A fake driver stands in for the chain, so these are about the protocol layer and run in
milliseconds.

| Section | Attacks |
|---|---|
| `gate` | replay (sequential, concurrent, every store shape), forged echoes, 15 malformed proofs, config floors |
| `invariants` | the **seams**: cross-transport replay, identifier idempotency, rail confusion, recency, budget races |
| `modes` | the three modes, the sovereignty loop, and every escalation attempt |
| `bounds` | every numeric knob at min, max, and one step past: amounts, decimals, caps, slippage, windows, identifier length |
| `selling` | a hostile buyer: underpayment, paying elsewhere, cross-offer replay, concurrency, nonsense pricing |
| `merchant` | the adapters a seller deploys: paywall, tip jar, fetch handler, worker, middleware |
| `receipts` | receipt forgery and re-verification: a forged payTo, asset, amount or payer |
| `mcp` | the surface a MODEL drives: `PIPRAIL_MODE`, confirm wiring, contradictory knobs, read-only boot |

**A fake driver must be FAITHFUL, not permissive.** These sections stand a fake chain in for the
real one. A fake that accepts every token, every address and every asset reports a gate
configured with `token: 'NOTATOKEN'` as perfectly healthy, so a real regression in that check
sails straight through. Twice now a "finding" was really a lenient fake. Refuse exactly what the
real driver refuses.

### L3 — reality (`scripts/smoke/l3-*.mjs`)

Live, read-only, free. This is the layer that goes red without anybody touching the code.

| Section | Asks |
|---|---|
| `facilitators` | every `KNOWN_FACILITATORS` host over the network: is it up, and does it advertise the network we claim of it? |
| `swaps` | does every network `canSwapOn()` says is swappable actually return a live quote? |
| `endpoints` | our own deployed 402 on piprail.com: conformant, self-describing, and quotable by our own client |
| `reserves` | spendable vs held on every family, and the retained minimum on the four chains that have one |

### L4 — money (`scripts/smoke/l4-*.mjs`, needs `--money`)

Real mainnet, tiny amounts, from the gitignored test wallets.

| Section | Proves |
|---|---|
| `payments` | **18 rows across all 10 families**: `pay → 200 → receipt → replay refused`, plus Template-A nonce binding. Covers native coins and non-USDC tokens (USDT, USD1, USDG) |
| `sovereign` | an agent handed only a key earns real money end to end, unattended |

---

## Wallets and keys

L3 `swaps` and all of L4 read the per-family test wallets. Keys are read **at runtime**, inside
Node, and are never printed, logged, or returned anywhere a transcript could capture them. The
store is gitignored and blocked from shell access by a hook, so only code opens it.

Before an L4 run, check what is actually funded — a red L4 is far more often an empty wallet
than a broken chain:

```bash
cd .claude/skills/wallet-audit && node audit.mjs
```

The payer needs the token **and** native gas; the merchant may need a receive prerequisite
(a Stellar/XRPL trustline, an Algorand ASA opt-in, a NEAR storage deposit).
`client.planPayment(url)` reports exactly what is missing, which is why L4 checks it *before*
it spends.

---

## Two traps worth writing down

**The stablecoin is not always USDC.** Robinhood is USDG-only; TON and Tron carry USD₮ because
Circle issues no native USDC on either. Asking for USDC there tests nothing and reports a false
"no route". This cost a round of false findings once already.

**A test that passes in the full run can fail alone.** Section isolation is a feature: it
catches order dependence and leaked global state. It also catches harness bugs — setting
`PIPRAIL_NO_HINTS=1` to quieten the runner once broke a test that asserts that very hint is
printed. Sections inherit the environment unchanged; a suite that wants quiet sets the flag
itself.

---

## Finishing

```bash
npm run verify-gate      # typecheck + tests + builds + invariants + sync + prose
```

The map (`npm run sync`) is not optional and not a formality: it is what stops a fact drifting
between the SDK, the docs, the site and the integrations. If a change adds or moves a surface,
the rule goes in the same commit.

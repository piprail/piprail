---
name: add-chain-integration
description: >-
  The complete playbook for adding a new chain, blockchain family, EVM preset,
  or token to PipRail — covering the SDK driver work AND the mandatory
  front-end/site update (including sourcing the chain/token SVG logo). Use this
  whenever the task is "add chain X", "add token Y on chain Z", "add a new
  preset", "support <some L1/L2>", or "wire up a new driver family". It encodes
  the project's hard rules (verify every address on-chain, mirror the driver
  templates, keep the protocol layer chain-agnostic, no backend/fee, and always
  ship the logo on piprail.com) so a new integration is correct and complete on
  the first pass.
---

# Adding a chain / family / token to PipRail

This is the canonical, do-it-every-time procedure — the reusable **"how"** for adding any
new chain, family, EVM preset, or token. Read it end-to-end before you start.

> The whole product is *immaculate simplicity* — `npm install`, name a chain,
> add a wallet, get paid. Every integration must preserve that. If a change
> makes PipRail heavier, you're doing it wrong.

---

## 0. The iron rules (violate none of these)

1. **Every token address is verified on-chain before it ships.** Read `symbol()`
   + `decimals()` (or the chain's metadata call) from a live mainnet RPC. Re-derive
   from the **issuer** (Circle / Tether / Ripple), never from a blog or aggregator.
   This rule has already caught real errors (testnet issuers posing as mainnet,
   third-party bridges posing as native). No exceptions.
2. **The native coin AND a stablecoin are BOTH mandatory — no chain ships without native.**
   Every integrated chain (a preset *or* a new family) MUST support, and be **live-proven on
   mainnet**, two payment assets. This is non-negotiable and has no exception:
   - **The chain's native coin** (`token: 'native'`) — fully wired through `resolveToken`,
     `describeAsset`, `pay`, `verify`, `estimateCost`, `balanceOf`, and `recipientReady`
     (for native: `balanceOf` reads the native coin, `recipientReady` → `'n/a'`), end-to-end. Native is the
     **zero-setup, always-available rail** (no token contract, no trustline / ATA / storage
     to receive), so it **must work 100% of the time**. If you think native "can't" be done
     on a chain, you're wrong: it is **digest-bound** wherever the tx can't carry a memo
     (EVM, Solana, Sui, Tron, NEAR — verified by the tx digest + a recency window + the
     gate's single-use set) and **memo/tag-bound** where it can (TON, Stellar, XRPL). Tron
     and NEAR were **retrofitted** with native in 1.1.0 *specifically to close this gap* —
     never reintroduce a "token-only" chain. Native is a valid payment asset on **every**
     family shipped today; keep it that way.
   - **At least one canonical stablecoin** — Circle-native **USDC** or Tether-native **USD₮**
     (issuer-native, per rule 3). Ship every one the chain has; a chain with **neither** earns
     **no preset** (it's documented byo-only — see §1).
   Both assets are verified on-chain (§2) **and** exercised by a real mainnet payment from the
   chain's test wallet before the chain is "done", and the family's `describe-asset` test MUST
   assert **native and ≥1 stablecoin**. A PR that adds a chain without a working `token:'native'`
   path is incomplete — send it back.
3. **Ship only ISSUER-NATIVE stablecoins.** "Issuer-native" = minted directly by
   Circle/Tether/Ripple on that chain (e.g. Sei's "USDT" is USDT0/LayerZero, *not*
   Tether-native → omitted). Bridged/wrapped tokens are **not** built in (callers can still
   pass them as a custom token). Document any omission inline, like TON's "native USDC doesn't
   exist here". *(This rule is about a stablecoin's provenance; the chain's own coin is rule 2 —
   don't confuse the two senses of "native".)*
4. **The protocol layer stays chain-agnostic.** `server.ts`, `client.ts`, `x402.ts`,
   `errors.ts` import **only** `drivers/types.ts`. Never add `viem`, `@solana/*`,
   `@ton/*`, or any chain lib to those files.
5. **Drivers mirror each other, file-for-file.** A family is `chains · wallet · pay ·
   verify · index`, functions are family-suffixed (`payEvm`/`paySolana`/`payTon`,
   `verifyEvm`/…). A new family copies the closest existing one.
6. **Optional chain libs are lazy.** Anything beyond `viem` (the one hard peer dep) is
   an **optional peer dep**, dynamically imported on first use. A pure-EVM install must
   never download `@solana/*`, `@ton/*` or `@stellar/*`. After `npm run build`, the main
   entry must have **zero static imports** of those libs (they live only in code-split
   `<family>-*` chunks) — verify with the dist grep in the §5 runbook, and keep it that way.
7. **Tests are the contract — change them first.** Behaviour change ⇒ test changes
   first, then code. `sdk/test/` (Vitest) is canonical.
8. **The site is part of "done."** A chain isn't shipped until it's on piprail.com with
   its real logo SVG. See §6 — this is the step that's easiest to forget and the user
   has flagged it as a hard requirement.
9. **No backend, no database, no auth, no dashboard, no fee, no hosted facilitator.**
   If an integration seems to need one, stop — it's the wrong design.
10. **Never publish.** Do not `npm publish` or touch the npm registry. Publishing is
    manual and owner-only.
11. **Every chain needs a test wallet — create one if it's missing.** Before building a
    family, check `.secrets/wallets/`. If there's no wallet for that chain, **generate a
    full one** (address + mnemonic/seed + public & private key — whatever that chain needs
    to sign and recover) with the chain's own keygen, write it to
    `.secrets/wallets/<family>-wallet.json` (`chmod 600`), and use it for the live smoke
    test. `.secrets/` is gitignored — **never commit a wallet, and never paste a private
    key/seed into code, logs, the transcript, or anywhere outside that file.** Generating a
    keypair is offline and free; *funding* it (native coin for fees + any
    trustline/account-creation) is a separate manual step the owner does — tell them what's
    needed. See §2.

---

## 1. First — classify the work (this decides everything)

| You are adding… | Driver work | Files you touch | Effort |
|---|---|---|---|
| **A token on a chain we already support** (e.g. EURC on Base) | none | that chain's `tokens` map in `drivers/<family>/chains.ts`; tests; README; **site** (token badge + maybe a `tokens/<sym>.svg`) | minutes |
| **A new EVM chain** (any L1/L2 viem can reach — incl. "native EVM" chains like Sei, Injective) | **none — reuse the EVM driver** | one row in `drivers/evm/chains.ts`; tests; README; CLAUDE.md; **site** (chain card + `chains/<slug>.svg`) | ~1 hour → §4 |
| **A new non-EVM family** (Solana-like, TON-like, Stellar, XRPL, Tron, Sui, Aptos, NEAR, Cosmos…) | **full new driver** | `drivers/<family>/` (5 files) + `types.ts` + `registry.ts` + `index.ts` + `package.json`; tests; README; CLAUDE.md; **site** | days → §5 |

**The single most common mistake is over-building.** A "new chain" that is EVM-compatible
(it has a chainId and JSON-RPC, even if it's a Cosmos/Move app-chain underneath like
Injective or Sei) is **just a preset row** — no new family. Only reach for §5 when the
chain genuinely speaks a different RPC/tx model than EVM.

> Quick test: *Does the chain have an EVM `chainId` and standard `eth_*` JSON-RPC, with
> ERC-20 USDC/USDT?* → **Path B (preset)**. Otherwise → **Path C (family)**.

> **Whichever path, native + a stablecoin are mandatory (iron rule 2).** A preset row and a new
> family both MUST ship a working `token:'native'` path **and** ≥1 canonical stablecoin (USDC or
> USD₮), each live-proven on mainnet. EVM presets get native for free (the EVM driver already
> handles it) — still smoke-test it. A new family must wire `'native'` explicitly through
> resolve/describe/pay/verify/estimateCost; a "token-only" family is **not shippable**.

> **The "byo-only, no preset" outcome.** A chain can have a perfectly good (even EVM) RPC and
> still **not** earn a preset: a preset's value is a pre-filled *canonical* stablecoin, so a
> chain with **no Circle/Tether-native USDC/USDT** is **documented byo-only** — it already
> works via `{ id, rpcUrl }` + `token` (native or custom), but you do **not** add a
> `chains.ts` row, a logo, or bump the count. Never preset a chain whose only stablecoin is
> third-party / low-liquidity. Worked example: **Bittensor (TAO), Subtensor EVM chain 964** —
> a live EVM chain, but with no Circle/Tether-native stablecoin, so it's documented byo-only,
> not presetted. Record each such call so it isn't re-litigated later.

---

## 2. Universal pre-flight — verify on-chain (do this before writing anything)

Never trust a pasted address. Confirm it live.

### EVM (with Foundry `cast` — preferred)

```bash
# chain id (must equal the preset / viem chain id)
cast chain-id --rpc-url "$RPC"
# token sanity — symbol + decimals must match what you're about to commit
cast call <TOKEN_ADDR> "symbol()(string)"   --rpc-url "$RPC"
cast call <TOKEN_ADDR> "decimals()(uint8)"  --rpc-url "$RPC"
```

### EVM (no Foundry — raw JSON-RPC fallback via curl)

```bash
# eth_chainId
curl -s "$RPC" -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'
# decimals()  → selector 0x313ce567 ; symbol() → 0x95d89b41
curl -s "$RPC" -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{"to":"<TOKEN_ADDR>","data":"0x313ce567"},"latest"]}'
```

Decode `decimals` from the hex result (e.g. `0x06` = 6, `0x12` = 18). Watch for the
classic gotcha: **Binance-Peg tokens on BNB Chain are 18 decimals**, not 6.

### Non-EVM

Use the chain's own metadata read, then re-derive from the issuer's official page:

| Chain | Metadata read | Issuer source to cross-check |
|---|---|---|
| Solana | `getTokenSupply` / mint account decimals | Circle multichain USDC page |
| TON | jetton master `get_jetton_data` | ton.org + Tether (USD₮ only; no native USDC) |
| Stellar | `account_lines` / asset toml | Circle Stellar docs (mainnet issuer ≠ testnet!) |
| XRPL | `account_lines` | Circle + Ripple RLUSD docs |
| Sui / Aptos | `suix_getCoinMetadata` / FA `Metadata` | Circle Move docs (Aptos: FA *metadata* addr ≠ *issuer* addr) |
| NEAR | NEP-141 `ft_metadata` | Circle NEAR docs (confirm *native*, not bridged) |
| Cosmos/Noble | `assetlist` / bank denom-metadata | Noble docs (IBC-denom nuance) |

**Rule:** a preset is not "done" until a tiny **real mainnet payment** has round-tripped
through `pay → confirm → verify` with the recoverable test wallet in `.secrets/`. If no
funded wallet exists for that chain yet, say so explicitly and treat the live smoke as a
separate ship-gate — don't silently skip it.

### Provision a test wallet (required — create one if it's missing)

A chain can't pass its live smoke test without a wallet, so make sure one exists in
`.secrets/wallets/` **before** you start. If it doesn't, generate a full keypair with the
chain's own tooling and persist everything needed to recover and reuse it — address,
mnemonic/seed, public key, private key:

```bash
mkdir -p .secrets/wallets
# Stellar (verified one-liner — Keypair.random() → G… address + S… secret seed):
node -e "const {Keypair}=require('@stellar/stellar-sdk');const k=Keypair.random();console.log(JSON.stringify({chain:'stellar',network:'pubnet',address:k.publicKey(),publicKey:k.publicKey(),secret:k.secret()},null,2))" > .secrets/wallets/stellar-wallet.json
chmod 600 .secrets/wallets/*.json
```

For other families, use that family's keygen the same way and store the equivalent fields:
- **EVM** — `viem`'s `generatePrivateKey()` → `privateKeyToAccount(pk).address` (store `address` + `privateKey`).
- **Solana** — `Keypair.generate()` → `publicKey.toBase58()` + `bs58.encode(secretKey)` (store `address` + `secretKey`).
- **TON** — `@ton/crypto` `mnemonicNew()` (24 words) → `mnemonicToWalletKey()` (store the `mnemonic` + derived address).

Then **confirm `.secrets/` is gitignored**, `chmod 600` the file, and tell the owner exactly
what to fund it with so the live payment smoke can run (e.g. Stellar: ~2 XLM for reserve +
fees, plus a USDC `changeTrust` trustline on the receiving account). Never print the secret
beyond writing the file; never commit it.

---

## 3. Path A — add a token to an existing chain

1. Verify the address on-chain (§2).
2. Add it to the chain's `tokens` map in `drivers/<family>/chains.ts`, keyed by
   UPPERCASE symbol, with an inline comment noting it was verified:
   ```ts
   // EURC verified on-chain 2026-06-02 (symbol/decimals read via RPC)
   EURC: { address: '0x…', decimals: 6, symbol: 'EURC' },
   ```
3. Tests: add a resolution assertion (`resolveChain('base').tokens.EURC` …).
4. README token coverage + CLAUDE.md "Key facts" token line if it changes the story.
5. **Site:** if it introduces a *new* token symbol, add `site/public/tokens/<sym>.svg`
   and the badge in the chain's `tokens: [...]` array (§6).

---

## 4. Path B — add an EVM preset (the common case: a new EVM chain)

This is exactly how Sei (1329) and Injective (1776) were added. It's **one row of data
plus tests plus docs plus the site** — zero new driver code.

1. **Verify on-chain** (§2): chainId, USDC/USDT `symbol()`+`decimals()`. Ship native
   Circle/Tether only — e.g. Sei's "USDT" is USDT0 (LayerZero), *not* Tether-native, so
   it's intentionally omitted.
2. **Does viem already export the chain?**
   ```bash
   node -e "const c=require('viem/chains'); console.log(c.sei?.id, c.injective?.id)"
   ```
   - **Yes** → import it: add the name to the `viem/chains` import in
     `sdk/src/drivers/evm/chains.ts` and use `chain: <name>`.
   - **No** → don't import; the caller-supplied `{ id, rpcUrl }` path already covers it,
     and you can still ship a preset by building the chain with `defineChain({...})`.
3. **Add the preset row** to `CHAINS` in `drivers/evm/chains.ts`, with an inline comment
   that records the verification and any token omission:
   ```ts
   // Sei EVM (pacific-1, chainId 1329) — native Circle USDC. Sei's "USDT" is
   // USDT0 (LayerZero), not Circle/Tether-native, so it's intentionally omitted.
   sei: {
     chain: sei,
     tokens: { USDC: { address: '0xe15f…', decimals: 6, symbol: 'USDC' } },
   },
   ```
4. **Tests** (`sdk/test/chains.test.ts`):
   - ⚠️ **GOTCHA:** the `CHAINS is iterable…` test asserts the *exact* key array with
     `toEqual([...])`. Adding a preset **will fail this test** until you append the new
     key(s) to that array. This is intentional (it stops accidental drift) — update it.
   - Add a dedicated assertion for the new chain (chainId, USDC decimals/symbol, and any
     token you deliberately omitted asserted `toBeUndefined()`).
5. **Docs:** add a row to the built-in chains table in `sdk/README.md` (and `sdk/CHAINS.md` if
   the chain has setup caveats), and update its prose counts — e.g. the spelled-out
   "all N families" phrasing only changes when a NEW FAMILY is added (an EVM preset doesn't
   touch it). **Do NOT edit a count in `CLAUDE.md`** — it intentionally carries none
   ("don't duplicate counts here") and defers to `sdk/README.md` + `sdk/CHAINS.md`. Add the
   chain to CLAUDE.md's "Key facts" list only if it isn't already covered by "every major EVM
   chain plus …".
6. **Site (mandatory):** §6 — add the chain to the `chains` array, grab its SVG, bump the
   "chains built in" stat tile to the new grand total, and re-spell the EVM-only count in the
   `#chains` grid heading (and every echoed copy). Don't trust any number quoted here — read the
   live values per §6a steps 2–3.

---

## 5. Path C — add a new non-EVM family (the big one)

Mirror the existing driver of your **binding template** (see below) — for Template A, Stellar
is the freshest reference (memo-bound via MEMO_HASH, string-amount, reader-injected verify);
TON is the clean async-settlement example; Algorand is the newest family added, so its folder is
the freshest end-to-end reference for the current contract. Pick your binding model first — it's
the only real design decision:

- **Template A — memo-bound** (mirrors `drivers/ton/`): the chain has a native
  memo/tag/comment field. Client puts the challenge `nonce` in it; `verify()` re-derives
  the watched account from the **trusted `accept`** (never the client's ref), finds the
  inbound transfer carrying that nonce, checks success + amount ≥ required + recency.
  Cryptographically bound. Use for: Stellar, XRPL, NEAR's NEP-141 token path, Algorand, Cosmos.
- **Template B — digest-bound** (mirrors `drivers/evm/` + `drivers/solana/`): no memo.
  The proof ref *is* the tx hash/digest; binding = single-use proof + recipient + amount
  + asset + recency. Use for: Tron, Sui, Aptos, and every native-coin path. (NEAR is a hybrid:
  its native path is digest-bound, its NEP-141 token path is memo-bound but still verified by
  tx hash — see near/verify.ts and §9.) **On digest-bound chains, persistent
  `isUsed`/`markUsed` is required for any multi-instance/restart deployment** and keep
  `maxTimeoutSeconds` tight (see the "Five Attacks on x402" note in the plan README §3a).

### The mechanical checklist (mirrors plan README §5, expanded)

1. **`drivers/<family>/` folder, file-for-file with `ton/`:**
   - `chains.ts` — preset(s): RPC endpoint, CAIP-2 id, `tokens` map, native decimals.
     Use the **official CAIP-2 id where the spec assigns one** (`stellar:pubnet`,
     `sui:mainnet`, `aptos:1`, `solana:5eykt4Us…`); invent a stable internal id where it
     doesn't (zero interop impact — we self-verify).
   - `wallet.ts` — `assert<Family>Wallet()` (validate the caller's config) +
     `resolve<Family>Wallet()` (wrap it into the signer object).
   - `pay.ts` — `pay<Family>(...)`: build + sign + broadcast the transfer. For Template A,
     embed `accept.extra.nonce` in the memo/tag.
   - `verify.ts` — `verify<Family>(...)`: RPC-only, in-process. Returns a `VerifyResult`.
     **Always re-derive the watched account from the trusted `accept`, never from the
     client ref.** Check: tx succeeded, recipient = `accept.payTo` (or derived token
     account), amount ≥ required, asset matches, recent, and (Template A) nonce matches.
   - `index.ts` — the `PaymentDriver` + `ResolvedNetwork`. Implement **every** method of the
     contract in `drivers/types.ts` (the type won't compile if you skip one):
     `resolve` · `supports` · `resolveToken` · `describeAsset` · `assertValidPayTo` ·
     `bindWallet` · `send` · `confirm` · `estimateCost` · `balanceOf` · `recipientReady` · `verify`.
     `resolveToken` must reject foreign-family token shapes with `WrongFamilyError` (an EVM
     `{address}` on a TON chain, etc.).
     - **`describeAsset(asset)`** (required — part of the `ResolvedNetwork` contract) returns the
       SDK's OWN `{ decimals, symbol }` for a recognised built-in token or the native coin —
       a **pure, synchronous** reverse-lookup of your `chains.ts` token map + native, **never
       an RPC call** — and `null` for any asset it can't price. It's the trusted inverse of
       `resolveToken` that the client's spend-budget guard uses to enforce limits against the
       token's *true* decimals (so a server can't understate a price by lying about
       `extra.decimals`). Mirror an existing driver (`evm/index.ts` normalises the address
       with `getAddress` first; `stellar/index.ts` is the non-EVM reference). A driver that
       omits it won't satisfy the `ResolvedNetwork` type — `typecheck` fails.
     - **`estimateCost(accept, opts?)`** (required) returns a {@link CostEstimate} — the
       best-effort NETWORK FEE (gas) to settle `accept`, in the chain's **native coin** (the
       gas token, distinct from the payment token). Compute your chain's fee as a `bigint` of
       native base units (EVM gas × price, Solana lamports, Tron energy × price, XRPL drops, …)
       and shape it with the shared `nativeCost()` helper (`util/cost.ts`). Async — may read
       RPC where it's cheap and meaningful (EVM gas price, XRPL open-ledger fee) — but **never
       throw** for a transient RPC issue: catch and return a typical-cost constant with
       `basis: 'heuristic'`. Use `opts.from` to sharpen sender-dependent fees (Tron energy via
       `triggerConstantContract`); otherwise a conservative heuristic. The client's
       `estimateCost(url)` surfaces it; the gate never calls it. Mirror `tron/index.ts` (the
       only chain where gas is materially expensive) or `evm/index.ts`.
     - **`balanceOf(wallet, asset)`** (a required `ResolvedNetwork` method — the affordability half
       of `client.planPayment`; confirm it's still in the `types.ts` contract before relying on this) returns a {@link WalletBalance} `{ token, native }` in base units:
       the bound `wallet`'s own balance of the payment `asset` **and** of the native gas coin.
       **RPC-read-only and NEVER throws** — a field whose read was unavailable (rate-limited /
       transient) comes back `null` (= "unknown"), **never `0`** (which would falsely read
       "broke"). For `asset === 'native'`, `token === native`. Payer-side + informational — the
       gate never calls it. Mirror `evm/index.ts` (ERC-20 `balanceOf` + `getBalance`) or
       `solana/index.ts` (ATA `getAccount`, where `TokenAccountNotFoundError` → a real `0n`
       because a missing ATA genuinely means zero — distinct from an unreadable `null`).
     - **`recipientReady(payTo, asset)`** (a required `ResolvedNetwork` method — the recipient-readiness half
       of `planPayment`) answers "can `payTo` RECEIVE `asset` right now?" by probing the chain's
       **one-time receive prerequisite**, returning `{ ready, reason? }`:
       - `{ ready: 'n/a' }` — the family has **NO** prerequisite (EVM, Solana, TON, Tron, Sui,
         Aptos — and **every native coin**, so early-return `'n/a'` whenever `asset === 'native'`).
       - `{ ready: true }` — the prerequisite is satisfied.
       - `{ ready: false, reason }` — it's missing; `reason` is a {@link RecipientReason}:
         `NO_TRUSTLINE` (Stellar/XRPL) · `NOT_REGISTERED` (NEAR `storage_deposit`) ·
         `NOT_OPTED_IN` (Algorand ASA) · `INACTIVE` (unfunded Stellar/XRPL account). This is what
         lets an agent fix the **recipient** instead of wasting a payment on an account that can't
         receive (it surfaces as `RecipientNotReadyError` on the pay path).
       - `{ ready: 'unknown' }` — the probe read failed (transient).
       **Also RPC-read-only and NEVER throws.** It reads ONLY the given `payTo` (re-derives nothing
       from a client ref). If your chain has a real receive gate, mirror `stellar/index.ts` /
       `xrpl/index.ts` (trustline + activation), `near/index.ts` (`storage_balance_of`), or
       `algorand/index.ts` (ASA opt-in) — and add a new reason to the `RecipientReason` union in
       `types.ts` if none fits. If your chain has no gate (auto-creates the recipient on receipt),
       just `return { ready: 'n/a' as const }` — mirror `evm`/`solana`/`sui`/`aptos`/`ton`/`tron`.

     > **`balanceOf` + `recipientReady` are the never-throw, read-only completion of the agent
     > trio** the client exposes as `quote()` (price) → `estimateCost()` (gas) →
     > **`planPayment()`** (can I settle, and where). `planPayment` composes `describeAsset` +
     > `estimateCost` + `balanceOf` + `recipientReady` across every rail a 402 offers — so if any
     > of those four lies or throws on your new family, `planPayment` / `canAfford` / `autoRoute`
     > silently misjudge it. The golden rule for both: **a failed read is `null` / `'unknown'`,
     > NEVER a thrown error and NEVER a false `0`.**
2. **`drivers/types.ts`:** extend `ChainFamily` (`… | '<family>'`) and `ChainSelector`,
   and add the family's token shape (`StellarToken { issuer; code; decimals }`,
   `SuiToken { coinType; decimals }`, etc.). Add it to the `TokenInput` union.
   - ⚠️ **Adding a token shape to `TokenInput` breaks narrowing in the other drivers'
     `resolveToken`.** The cross-family rejection is **data-driven** — do NOT hand-add inline
     `if ('x' in token)` guards to every driver (that older approach was replaced). Instead:
     1. Add your family to BOTH maps in [`drivers/shared.ts`](../../../sdk/src/drivers/shared.ts):
        `FAMILY_LABEL` (human label) and `FAMILY_TOKEN` (`{ key: '<discriminant>', shape, hint }`
        — e.g. Stellar → `{ key: 'issuer', shape: '{ issuer, code }', hint: '{ issuer, code, decimals }' }`).
     2. In your OWN driver's `resolveToken`, after the `'native'` + symbol cases and before you
        read your own token field, call `rejectForeignToken(token, '<family>', network)`
        (mirror `evm/index.ts`). One map edit covers rejection on **every** existing driver at
        once — and the existing drivers already call `rejectForeignToken`, so they reject your
        new shape automatically. See `ERRORS.md` §8 (shared building blocks).
3. **`drivers/registry.ts` → `familyForChain`:** route the new string selector. Keep it
   pure + synchronous:
   ```ts
   if (chain.startsWith('stellar')) return 'stellar'
   ```
4. **`drivers/index.ts` → `loaders`:** EVM is registered **eagerly** at module load
   (`registerDriver(evmDriver)`, because viem is the one hard peer dep that's always present), so
   it is **not** in the loader map; **every other family** has exactly one lazy entry there
   (`ls sdk/src/drivers/` to see the current set, and the loader map is the source of truth for
   which are lazy). Add yours: an `async () =>` that does `await import('./<family>/index.js')` then
   `registerDriver(mod.<family>Driver)`, wrapped in a `try/catch` that throws a
   `MissingDriverError` naming the exact `npm install …` for that family's optional peer
   dep(s). The async `resolveNetwork` the gate/client use awaits `ensureDriver(familyForChain(chain))`
   first (it de-dupes concurrent imports via one in-flight promise per family, and does NOT
   cache a failed import so a later call can retry), then delegates to the synchronous
   resolve. This is what makes `chain: '<name>'` "just work" with no setup call.
   ⚠️ Keep the split straight: **deps-not-installed → `MissingDriverError`** (thrown by the
   loader), **chain-not-supported / `resolve()`→null → `UnsupportedNetworkError`** — never
   reuse one for the other.
5. **`package.json`:** add the libs as **optional peer deps** (and `peerDependenciesMeta:
   { …: { optional: true } }`), never as hard deps. Update `tsup.config.ts` externals and
   `vitest.config.ts` if a new entry/extern is needed. Keep the EVM bundle clean.
6. **Tests (`test/<family>/{driver,verify,pay}.test.ts`):** mirror TON's —
   token resolution + amount scaling, `payTo` validation (accept the right format, reject
   foreign families with `WrongFamilyError`), wallet binding, and a **mocked `verify()`**
   covering success / amount-too-low / wrong-recipient / wrong-asset / expired / reverted /
   not-found / (Template A) wrong-nonce. Add a `familyForChain('<name>')` assertion to
   `test/routing.test.ts`. The verify test injects the narrow reader (a plain mock), and
   the pay test injects a mock client to assert the built tx (memo binds to the nonce,
   right destination/asset/amount). **Lazy-load check** is a `dist/` grep after build (see
   the runbook), not a unit test.
7. **Docs + Site:** README `chain` union + table (+ `CHAINS.md` for caveats); `CLAUDE.md` has
   **no count to bump** (it defers to README/CHAINS.md) — add the chain to its "Key facts" list
   only if not already covered; and the full site update (§6).

### Two patterns the templates bake in (get these right)

- **Amount model.** `accept.amount` is always **base units** — an integer string,
  `parseUnits(human, decimals)`. EVM/Solana/TON pay *and* verify in base units directly.
  But some chains transact in **human-decimal strings** (Stellar: 7 dp). There: *pay* with
  `accept.extra.amountFormatted` (already validated to ≤ `decimals` dp at challenge time),
  and in *verify* convert the chain's amount string back with `parseUnits(amountStr, decimals)`
  before comparing to `BigInt(accept.amount)`. **Never reuse the EVM integer scaler for a
  string-amount chain** (and vice-versa).
- **Nonce binding (Template A).** The default nonce is `crypto.randomUUID()` — 36 chars.
  If the chain's memo field is short (Stellar `MEMO_TEXT` ≤ 28 bytes, XRPL DestinationTag is
  a uint32), bind via a **hash**: `MEMO_HASH = sha256(nonce)` (32 bytes) on pay, re-derive
  the same hash in `verify()`. A hash always fits, never leaks the nonce on-chain, and the
  match is exact. Verify by reading the watched account's recent txs and matching that memo.

### The exact runbook (the steps actually run for the Stellar build, 2026-06-02)

```bash
# 0. Confirm the chain's binding template (A: memo/nonce-bound · B: digest-bound) + tokens.
# 1. Install the chain lib as a devDependency (so tests + build resolve it):
cd sdk && npm install -D @scope/chain-sdk
# 2. Provision the test wallet if none exists (§2) — address + seed + keys, chmod 600.
# 3. Verify EVERY token address LIVE before writing presets (§2): the chain's metadata
#    read, re-derived from the issuer (for Stellar: a Horizon /assets read confirming the
#    MAINNET issuer + code — NOT the testnet issuer the plan warns about).
# 4. Create drivers/<family>/{chains,wallet,pay,verify,index}.ts  (copy ton/, adapt).
#    REQUIRED (iron rule 2): resolveToken/describeAsset/pay/verify/estimateCost/balanceOf/
#    recipientReady MUST handle token:'native' — never throw "token-only" (for native: balanceOf
#    reads the native coin, recipientReady → 'n/a'). Native is digest-bound (no memo) or memo-bound.
#    balanceOf + recipientReady are RPC-read-only and NEVER throw (null/'unknown' on a failed read).
# 5. Wire the touchpoints: types.ts; your family's row in drivers/shared.ts (FAMILY_LABEL +
#    FAMILY_TOKEN) and a rejectForeignToken(...) call in your own resolveToken; registry.ts
#    familyForChain; drivers/index.ts loaders; package.json optional-peer + devDep; tsup external.
# 6. Write test/<family>/{driver,verify,pay}.test.ts + the routing.test.ts assertion + the new
#    family's cases in test/describe-asset.test.ts (native, a built-in token, unknown → null),
#    test/cost.test.ts (deterministic fee + never-throws), and test/recipient-ready.test.ts (the
#    family's prerequisite outcome, or 'n/a' if it has none). FIRST. (planPayment itself is covered
#    by the protocol-layer test/plan-payment.test.ts via a fake net — no per-family work there.)
npm run typecheck && npm run typecheck:test && npm test   # typecheck:test type-checks tests too (they're excluded from the build)
# 7. Build + PROVE the lazy-load invariant (main entry must not statically import the lib):
npm run build
grep -nE "(from ?['\"]@scope/chain-sdk|require\(['\"]@scope/chain-sdk)" dist/index.js dist/index.cjs   # → NOTHING
grep -rl "@scope/chain-sdk" dist/ | grep -vE "index\.(js|cjs|mjs)"   # → only the <family>-*.{js,cjs} chunk
# 8. Docs: README chains table + custom-token example (CLAUDE.md has no count to bump).
# 9. Site (§6): SVG in the CORRECT order slot, chains array, stats count, grid heading.
cd ../site && npm run build      # 0 errors
```

**Ship gate (separate, after the wallet is funded):** two tiny REAL mainnet payments must
round-trip `pay → confirm → verify` — **one on the native coin (`token:'native'`) and one on
a stablecoin** (iron rule 2; native is not optional). Until then, validate the verify side
against a **live read-only RPC**: a fresh-nonce `verify()` against a real merchant account must
return `transfer_not_found` (a clean reject), not throw — proving the lazy mount, the live
client adapter, and the parser all work end-to-end. (That's exactly how Stellar was de-risked
before funding.)

The protocol layer, wire format, gate/client, and replay set are **untouched** by any of
this. If you find yourself editing `server.ts`/`client.ts`/`x402.ts` to add a chain, stop
— the abstraction is leaking.

---

## 6. The front-end is part of "done" — update the site + get the SVG

**This is a hard requirement, not a nice-to-have.** A chain that works in the SDK but
isn't on piprail.com with its real logo is *not shipped.* The site is **Astro 5 + Tailwind v4,
static-first, deployed to Netlify** (no SSR adapter) and has three pages —
`index.astro` (`/`), `mcp.astro` (`/mcp`), `demo.astro` (`/demo`). The chain you're adding
lands on the home page [`site/src/pages/index.astro`](../../../site/src/pages/index.astro),
but the chain data now lives in
[`site/src/data/chains.ts`](../../../site/src/data/chains.ts) (and the code snippets in
`site/src/data/snippets.ts`), rendered through small components (`CodeWindow`,
`SectionHeading`, `FeatureGrid`). Edit the **data file** for a chain; the page picks it up.
The chain-count totals also live in `Layout.astro` (SEO/JSON-LD) and `mcp.astro` — keep those
in sync (see steps 2–3).

### 6a. Wire the chain into the page

1. **`chains` array** — now in [`site/src/data/chains.ts`](../../../site/src/data/chains.ts)
   (imported by `index.astro`), no longer inline in the frontmatter. Add an entry — `slug`
   **must** equal the SVG filename (`/chains/<slug>.svg`), and `tokens` are the stablecoin
   badges shown. **List
   EVERY built-in stablecoin the chain ships** (don't undersell it) — and a badge needs its
   own `site/public/tokens/<sym>.svg`. Badges that exist today: `usdc`, `usdt`, `eurc`, `rlusd`. If a
   chain ships a stablecoin with no badge SVG yet (e.g. Stellar's EURC), **grab it from
   web3icons `tokens/branded/<SYM>.svg` (a filled brand-colour circle + white glyph) and add
   it** — this is an easy step to forget. ⚠️ The token `branded` variant often **insets** its
   circle (e.g. `r=9` in a `0 0 24 24` viewBox = ~75%), so it renders SMALLER than the
   full-bleed `usdc.svg`/`usdt.svg`. Crop the viewBox to the circle's bounds so it's full-bleed
   and the same apparent size (EURC: `viewBox="3 3 18 18"`). All token badges must be
   full-bleed circles.
   ```ts
   { name: 'Stellar', slug: 'stellar', tokens: ['usdc', 'eurc'] },
   ```
   **Order is deliberate — place by importance, NOT by when it was added.** This one array
   feeds *both* the hero strip *and* the `#chains` grid, and the "One word picks the chain"
   section renders only the **first 8** as pills (`+N more` after), so a chain's slot
   decides how prominently it shows. The canonical order:

   1. **Ethereum** — the reference chain, always first.
   2. **The non-EVM families, grouped together up front**, in roughly current importance:
      Solana, TON, Tron, NEAR, Sui, Aptos, Algorand, Stellar, XRPL (the live order in
      `chains.ts` today). A new non-EVM family joins this group by prominence.
   3. **The EVM chains by prominence** — Base, BNB, Arbitrum, Polygon, Optimism, Avalanche,
      then the rest; **newest / smallest last** (Sei, Injective sit at the tail).

   So the lead is **Ethereum · _the non-EVM families_ · _EVM by prominence_**. Insert a new
   chain at the slot its importance warrants — a new non-EVM family joins the front group, a
   niche EVM L2 goes at the tail. Don't just append. The grid auto-pads to a clean rectangle,
   so any count works.
2. **`stats` count** — the `{ icon: Boxes, v: '<N>', l: 'chains built in' }` tile (an entry in
   the `stats` array in `index.astro`'s frontmatter — each tile carries an `icon`) is the
   **grand total** of built-in chains (all EVM presets + every non-EVM family). Bump it to the
   NEW grand total whenever the set changes. ⚠️ This is a DIFFERENT number from the spelled-out
   EVM-only heading below — both must be kept in sync. The total is repeated across the whole
   site (at least `index.astro`, `Layout.astro`'s JSON-LD/SEO copy, `mcp.astro`, `demo.astro`,
   and `src/data/snippets.ts`), so don't hand-count: `grep -rn "chains built in" site/src` and
   `grep -rnE "[0-9]+ chains" site/src`, then update EVERY occurrence to the new total. To get
   the authoritative number, count the EVM presets in `sdk/src/drivers/evm/chains.ts` and add
   one per non-EVM family folder under `sdk/src/drivers/`.
3. **Grid heading copy** — the `#chains` section (via the `SectionHeading` component) carries a
   *spelled-out EVM-only count* (e.g. "…EVM mainnets, plus Solana, TON, Tron, NEAR, Sui, Aptos,
   Algorand, Stellar, and the XRP Ledger…"). When you add an EVM preset, re-spell this number to
   the new EVM-preset total (count the rows in `sdk/src/drivers/evm/chains.ts`); a non-EVM family
   bumps only the stat tile, not this number — but it DOES join the non-EVM list here. The same
   spelled-out EVM count / family list is echoed in the FAQ answers (`index.astro`'s `faqs`,
   `mcp.astro`) and the `19 EVM mainnets` style copy in `Layout.astro` / `mcp.astro` — grep them
   all (`grep -rnE "EVM mainnet" site/src`) and keep every occurrence in sync. Spell out the same
   number you put in numeric form elsewhere.
4. **Hero / token copy** — only if the integration changes the token story (e.g. adding a
   new stablecoin or native-coin support). Keep "USDC, USDT, or the native coin" accurate.

### 6b. Get the logo SVG (the part people forget)

Logos live in `site/public/chains/<slug>.svg` (chains) and `site/public/tokens/<sym>.svg`
(tokens). The existing set comes from the **web3icons** library (you'll see
`class="web3icons"` in them) — that's the canonical source, so a new logo matches the
house style automatically.

**House style (match this):**
- A single self-contained `<svg>` with a **square** `viewBox` (e.g. `0 0 24 24`,
  `0 0 56 56`, or the brand's own square artboard), `fill="none"` on the root.
- Brand-colour fill; for round-badge chains, a filled `<circle>` background + a white
  glyph (see `ton.svg`); for square-mark chains, a coloured square + glyph (see
  `base.svg`, `celo.svg`).
- **Tiny** — under ~2 KB. No `<script>`, no external refs, no raster `<image>`.
- The page renders it inside `rounded-full ring-1 ring-white/10`, so a flat square mark
  reads fine as a circle.
- **Dark background:** the card is near-black, so a glyph-only mark must be its **brand
  colour or white** — never black. A monochrome/black mark (e.g. Stellar's) must be
  recoloured to white (`fill="black"` → `fill="#fff"`): same official mark, correct
  dark-mode colour. (Verify it's actually visible, not lost against the card.)

**How to fetch it (verified recipe — exactly how Sei + Injective were sourced):**

The files live in the web3icons GitHub repo under `raw-svgs/networks/branded/<id>.svg`,
where `<id>` is **lowercase** and sometimes suffixed — it is *not* always the obvious slug
(Injective is `injective`, but Sei is **`sei-network`**). The published npm/jsDelivr `dist`
path does **not** serve these, so use the raw GitHub URL.

```bash
# 1) Find the exact id (don't guess — names are inconsistent):
curl -s "https://api.github.com/repos/0xa3k5/web3icons/git/trees/HEAD?recursive=1" \
  | grep -oiE '"path": "raw-svgs/networks/branded/[^"]*(sei|injective)[^"]*\.svg"'
#   → raw-svgs/networks/branded/sei-network.svg  /  …/injective.svg
# 2) Fetch the BRANDED variant by that exact path:
curl -fsSL "https://raw.githubusercontent.com/0xa3k5/web3icons/main/raw-svgs/networks/branded/sei-network.svg" -o /tmp/sei.svg
# 3) Eyeball it — real SVG markup? current official mark? right brand colour?
head -c 200 /tmp/sei.svg
```

web3icons has three variants: **`branded`** (brand-coloured glyph — **use this**, it matches
the existing set and already encodes per-brand whether the logo is a glyph or a filled tile
like Base), `mono` (monochrome), `background` (glyph on a solid tile). If web3icons lacks the
chain, take the SVG from the chain's official brand/press kit. **Always confirm it's the real,
current official mark** — a wrong/outdated logo is worse than none. Sanity-check it's
well-formed (`xmllint --noout file.svg`).

Normalise to the house style and save with the **exact slug** your `chains` entry uses (note
the web3icons filename may differ — `sei-network.svg` → `sei.svg`):

```bash
sed -E '1 s|<svg |<svg class="web3icons" |' /tmp/sei.svg > site/public/chains/sei.svg
```

**If no clean official SVG exists:** hand-author one in the house style — the official
**brand colour** + a simple geometric glyph or the chain's lettermark — rather than
shipping a blurry traced raster. Keep it square and tiny.

**Normalise before committing:** open it, strip junk (`<?xml?>`, editor metadata,
comments, `width`/`height` if you want it to scale to the CSS box), confirm one square
`viewBox`, and (optionally) run it through SVGO. Name it exactly `<slug>.svg` so it
matches the `chains` array entry.

### 6c. Verify the site

```bash
cd site && npm run build      # must finish with 0 errors
```
Then eyeball the hero strip and the `#chains` grid (`npm run dev`) — the new logo should
render crisp at 28px and 40–48px, sit nicely in its ring, and the grid should stay a
clean rectangle.

---

## 7. Error handling — one model for every chain

Whoever hits an error — a human dev, the merchant server, or an AI agent — must get a
**typed, understandable reason**, never an opaque chain-library blob. There are exactly two
channels, both chain-agnostic; a new driver must use both correctly. **The authoritative
standard is [`sdk/ERRORS.md`](../../../sdk/ERRORS.md)** (its §5 is the per-method driver error
contract; the `errors.ts` header summarizes it). Conform to it verbatim.

**1. Returned — `VerifyResult` with a `VerifyErrorCode` (server-side verification).**
`verify()` returns `{ ok: false, error, detail }` where `error` is one of the canonical
codes in `x402.ts`: `tx_not_found`, `tx_reverted`, `insufficient_confirmations`, `no_meta`,
`wrong_recipient`, `amount_too_low`, `transfer_not_found`, `payment_expired`,
`tx_already_used`. **The compiler enforces the set — you can't invent a code.** Use the same
code other drivers use for the same condition: "scanned the merchant account, nothing matched
the nonce" → `transfer_not_found`; "found it, but too small" → `amount_too_low`; "found it,
but it failed on-chain" → `tx_reverted`; "older than the replay window" → `payment_expired`.
The gate turns this into a 402 body `{ status: 'invalid', error, detail }`, and the client
relays it to the agent.

**2. Thrown — a typed `PipRailError` subclass (config / flow / wallet).** Each carries a
stable `.code`, so a caller can do `catch (e) { if (e instanceof PipRailError) … }` or branch
on `e.code`. A driver throws:
- `WrongFamilyError` — wrong-family wallet, `payTo`, or token shape (message names the right shape).
- `InsufficientFundsError` — map affordability failures in `send()` with the shared helper:
  ```ts
  async send(wallet, accept) {
    try { return await pay<Family>({ … }) }
    catch (err) { throw toInsufficientFundsError(err) ?? err }   // same typed error on every chain
  }
  ```
  `toInsufficientFundsError` (in `errors.ts`) recognises the common "can't afford it" messages
  across libs and returns `null` for anything else (so the original error propagates unchanged
  — never swallow it). EVM and Stellar additionally use their lib's structured signal (viem's
  `BaseError` walk; Horizon `result_codes`).

The registry throws `MissingDriverError` / `UnsupportedNetworkError`; the client throws
`InvalidEnvelopeError`, `NoCompatibleAcceptError`, `PaymentTimeoutError`, and
`MaxRetriesExceededError` — which **includes the server's `error` + `detail`**, so when a
payment is rejected the agent learns *why* (`amount_too_low — Paid 40000, required 500000`),
not just "retries exhausted".

**New-driver error checklist:**
- [ ] `verify()` returns ONLY canonical `VerifyErrorCode`s (compiler-enforced) — same code as other drivers for the same condition.
- [ ] `send()` wraps its broadcast: `catch (err) { throw toInsufficientFundsError(err) ?? err }`.
- [ ] Wrong-family wallet / `payTo` / token → `WrongFamilyError` naming the right shape.
- [ ] Never swallow a chain error — map the ones you recognise, rethrow the rest unchanged.

---

## 8. Definition of done (copy this checklist into the task)

```
SDK
- [ ] Every token address verified on-chain (live RPC / issuer read), native-only
- [ ] (Path B) preset row added to evm/chains.ts with verification comment
- [ ] (Path C) drivers/<family>/ implements the full PaymentDriver contract incl. describeAsset
      (pure synchronous true-decimals/symbol lookup; null for unknown) + the describe-asset.test case
- [ ] (Path C) estimateCost(accept, opts?) implemented via the shared nativeCost() helper — native-coin
      fee, never throws (heuristic fallback) + a cost.test case (deterministic heuristic/fallback)
- [ ] (Path C) balanceOf(wallet, asset) + recipientReady(payTo, asset) implemented (both are required ResolvedNetwork methods) — both
      RPC-read-only and NEVER throw: balanceOf → { token, native } base units, null-not-zero on a failed
      read; recipientReady → the chain's receive prerequisite ({ ready:false, reason } / true / 'unknown')
      or { ready:'n/a' } if none (and always 'n/a' for native). These power client.planPayment(); the gate
      never calls them. + a recipient-ready.test case (and a new RecipientReason in types.ts if needed)
- [ ] (Path C) types.ts / registry.ts / index.ts loader / package.json optional-peer + devDep / tsup external wired
- [ ] (Path C) new family added to drivers/shared.ts FAMILY_LABEL + FAMILY_TOKEN maps (covers cross-family
      rejection on EVERY driver); own resolveToken calls rejectForeignToken(token, family, network)
- [ ] chain: '<name>' works with NO setup call (lazy-mounts; main bundle free of the lib — dist grep)
- [ ] Nonce binding holds: a proof for challenge A cannot satisfy challenge B
- [ ] Errors (§7): verify() returns only canonical VerifyErrorCode; send() maps affordability via
      toInsufficientFundsError; wrong-family → WrongFamilyError
- [ ] Tests updated FIRST: per-chain driver/verify/pay tests + routing.test assertion
- [ ] Full gate (sdk/STANDARDS.md §6): npm run typecheck ✓  npm run typecheck:test ✓  npm test ✓
      npm run build ✓ (lazy chunks intact via dist grep)

Docs
- [ ] sdk/README.md chains table / token coverage updated (+ sdk/CHAINS.md if the chain has caveats); re-spell any prose count (e.g. "all N families") only when a NEW FAMILY is added
- [ ] CLAUDE.md: NO count to edit (it defers to README/CHAINS.md) — add the chain to the "Key facts" list only if not already covered
- [ ] (run the docs-sync skill to catch every surface a count/chain touches, incl. the separate piprail/.github org-profile repo)

Site (NOT optional)
- [ ] site/public/chains/<slug>.svg (and tokens/<sym>.svg if new token) — official current mark, house style, recoloured for the dark bg if monochrome
- [ ] data/chains.ts: chains array entry AT THE RIGHT ORDER SLOT (Ethereum · the non-EVM families · EVM-by-prominence — not appended blindly); index.astro: stats count, grid heading copy, hero/token copy if changed
- [ ] cd site && npm run build ✓ (0 errors), grid renders clean

MCP (no work — just confirm)
- [ ] @piprail/mcp (the separate, published mcp/ workspace) auto-exposes ANY chain the SDK
      supports — a new chain needs ZERO MCP changes. EVM presets work out of the box (the
      server ships viem); a new non-EVM family is reachable the moment its optional peer lib
      is installed alongside the MCP, same as the SDK. Nothing to edit here.

Propagation (don't let a count rot in a surface you forgot)
- [ ] Run the **docs-sync** skill — it's the map of EVERY place the chain set / count lives,
      including the SEPARATE piprail/.github org-profile repo (its profile/README.md mirrors the
      chain list + count) and any external directory listings. Update those too; the SDK/site
      changes here do NOT reach the org repo automatically.

Ship gate (separate, explicit)
- [ ] A test wallet for this chain exists in .secrets/wallets/ (generate one if missing:
      address + seed/mnemonic + keys, gitignored, chmod 600). Tell the owner what to fund.
- [ ] One tiny REAL mainnet micro-payment round-trips pay → confirm → verify
      (recoverable wallet in .secrets/). If no funded wallet for this chain, flag it.
- [ ] Do NOT npm publish — publishing is manual/owner-only
```

---

## 9. Pointers (read these when in doubt)

- **Binding templates:** every family uses one of two proof bindings — **Template A**
  (memo/nonce-bound: e.g. Stellar, XRPL, NEAR NEP-141, Algorand, TON) or **Template B**
  (digest-bound by tx hash: e.g. EVM, Solana, Tron, Sui, Aptos). Copy the closest existing
  driver of the same template as your starting point.
- **Build standard:** [`sdk/STANDARDS.md`](../../../sdk/STANDARDS.md) — the canonical "how we
  build a driver/feature" doc (layering, opt-in defaults, the test contract, and §6's
  verification gate: `typecheck` + `typecheck:test` + `test` + `build` + the lazy-chunk grep).
  Note `typecheck:test` exists because tests are excluded from the build, so plain `typecheck`
  won't catch a type error in your new `test/<family>/` files.
- **The contract:** [`sdk/src/drivers/types.ts`](../../../sdk/src/drivers/types.ts) — the only
  thing the protocol layer depends on (incl. `describeAsset`, `estimateCost`, `balanceOf`,
  `recipientReady`, plus the `WalletBalance` / `RecipientReason` types — the live `types.ts` is
  the source of truth for the current method set). The
  protocol layer also carries chain-agnostic agent features (`policy.ts`, `ledger.ts`, `agent.ts`
  toolkit, and the read-only trio `client.quote()` → `client.estimateCost()` →
  `client.planPayment()` / `canAfford()`) — none need per-driver work, but they RELY on your
  driver: `describeAsset` for true decimals/symbol, `estimateCost` for gas, and `balanceOf` +
  `recipientReady` for the affordability + recipient-readiness that `planPayment` reports across
  every rail. The gate's multi-chain `accept[]` selects your `verify()` by network+asset.
- **Error standard:** [`sdk/ERRORS.md`](../../../sdk/ERRORS.md) — the single source of truth;
  implemented in [`sdk/src/errors.ts`](../../../sdk/src/errors.ts) (`PipRailError` +
  `toInsufficientFundsError`) and the `VerifyErrorCode` union in
  [`sdk/src/x402.ts`](../../../sdk/src/x402.ts).
- **Routing + auto-mount:** [`registry.ts`](../../../sdk/src/drivers/registry.ts) (`familyForChain`)
  and [`drivers/index.ts`](../../../sdk/src/drivers/index.ts) (lazy `loaders`).
- **Templates to copy:** [`drivers/stellar/`](../../../sdk/src/drivers/stellar/) (the freshest
  Template A — memo-bound via MEMO_HASH, string-amount, reader-injected verify),
  [`drivers/ton/`](../../../sdk/src/drivers/ton/) (memo-bound, async settlement),
  [`drivers/evm/`](../../../sdk/src/drivers/evm/) + [`drivers/solana/`](../../../sdk/src/drivers/solana/) (digest-bound).
- **EVM presets data:** [`drivers/evm/chains.ts`](../../../sdk/src/drivers/evm/chains.ts).
- **The site:** [`site/src/pages/index.astro`](../../../site/src/pages/index.astro), logos in
  [`site/public/chains/`](../../../site/public/chains/) + [`site/public/tokens/`](../../../site/public/tokens/).
- **Project rules:** the root [`CLAUDE.md`](../../../CLAUDE.md) — "keep it a tool, not a platform."

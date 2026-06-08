# Chain support & per-chain setup

PipRail works the same way on every chain — `requirePayment({ chain, token, amount, payTo })`
to charge, `new PipRailClient({ chain, wallet }).fetch(url)` to pay. But the chains
themselves differ, and a few have **setup steps you must do before a wallet can pay or
receive**. This page is the exact list.

**Most chains need nothing special.** The ones with caveats are **NEAR**, **TON**,
**Stellar**, **XRPL**, **Tron**, and **Algorand** (USDC needs a one-time ASA opt-in) —
read those sections before you ship them.

## At a glance

| Chain(s) | Pay in native coin? | Built-in stablecoins | Receiver needs setup? | Wallet input |
|---|:--:|---|---|---|
| **EVM** (Ethereum, Base, Arbitrum, Optimism, Polygon, BNB, Avalanche, Mantle, Sonic, Linea, Scroll, Celo, zkSync, Unichain, World Chain, Sei, Injective, HyperEVM, Monad, Kaia, + any EVM chain) | ✅ ETH/BNB/POL/… | USDC (all **except Kaia**) · USDT (all **except Base, World Chain, Sei, HyperEVM, Monad**) | No | `{ privateKey }` |
| **Solana** | ✅ SOL | USDC · USDT | No (payer creates the recipient's token account) | `{ secretKey }` |
| **Sui** | ✅ SUI | USDC (no USDT) | No | `{ privateKey }` (`suiprivkey1…`) |
| **Aptos** | ✅ APT | USDC · USDT | No (primary FA store auto-creates) | `{ privateKey }` (`ed25519-priv-0x…`) |
| **Algorand** | ✅ ALGO | **USDC only** (Tether deprecated USDT) | USDC: ⚠️ **ASA opt-in** · **native ALGO: none** | `{ mnemonic }` (25 words) |
| **Stellar** | ✅ XLM | USDC · EURC | ⚠️ **Yes — trustline + funded account** | `{ secret }` (`S…`) |
| **XRP Ledger** | ✅ XRP | USDC · RLUSD (no USDT) | ⚠️ **Yes — trustline + activated account** | `{ seed }` (`s…`) |
| **TON** | ✅ TON | **USD₮ only** (no USDC) | No (payer's gas auto-deploys the jetton wallet) | `{ mnemonic }` (24 words) |
| **Tron** | ✅ TRX | **USD₮ only** (no USDC) | No | `{ privateKey }` |
| **NEAR** | ✅ NEAR | USDC · USDT | tokens: ⚠️ `storage_deposit` · **native NEAR: none** | `{ accountId, privateKey }` |

> **`token: 'native'`** (paying in the chain's own coin) is accepted on **every family** —
> EVM, Solana, Sui, Aptos, Algorand, Stellar, XRPL, TON, NEAR, **and Tron** (native TRX,
> digest-bound). No exceptions. On NEAR, native is the **zero-setup** path: no `storage_deposit`,
> and a transfer even creates a fresh recipient (the NEP-141 token path still needs
> `storage_deposit`).
>
> **Custom tokens** work everywhere with no allowlist: EVM `{ address, decimals }` ·
> Solana `{ mint, decimals }` · Sui `{ coinType, decimals }` · Aptos `{ metadata, decimals }` ·
> Algorand `{ assetId, decimals }` · TON `{ master, decimals }` ·
> Tron `{ address, decimals }` · NEAR `{ contractId, decimals }` · Stellar
> `{ issuer, code, decimals }` · XRPL `{ issuer, currencyHex, decimals }`.

**Universal:** the public default RPC on every chain is rate-limited — **pass your own
`rpcUrl`** in production (there's no separate API-key field; fold any key into the URL).

---

## Chains with no caveats

### EVM — Ethereum, Base, Arbitrum, Optimism, Polygon, BNB, Avalanche, …
- **Pay in:** native coin (`'native'`), `'USDC'`, `'USDT'`, or a custom `{ address, decimals }`.
- **USDT gap:** built in on every preset **except Base, World Chain, Sei, HyperEVM, and Monad** (USDC only there). **Kaia** is the inverse — **USD₮ only** (no Circle-native USDC on Kaia).
- **Decimals:** on **BNB Chain**, Binance-Peg USDC/USDT are **18 decimals**, not 6 (the SDK handles it; don't hardcode 6).
- **Stablecoin provenance — issuer-native vs bridged (every shipped address verified on-chain 2026-06-08, incl. bridge markers).** Every address is the correct, canonical, 1:1-redeemable dollar token on its chain; what varies is *who issues it*. You request it as `'USDC'` / `'USDT'` either way — provenance matters only if you specifically require issuer-native settlement.
  - **USDC** is **Circle-native** on every preset **except** **BNB** (Binance-Peg, 18-dp), **Mantle** (OP canonical-bridge), and **Scroll** (Bridged-USDC-Standard) — the last two are backed 1:1 by Circle USDC on Ethereum but are **not** Circle-issued on that chain (absent from Circle's native-USDC list).
  - **USDT** is **Tether-native** on **Ethereum, Avalanche, Celo, Kaia** (EVM) and **Solana, Tron, TON, NEAR, Aptos** (non-EVM). Everywhere else it's bridged: **USDT0** (LayerZero omnichain, on-chain `symbol()` = `USD₮0`) on **Arbitrum, Polygon, Unichain**; a **canonical-bridge** token (chain-minted, backed by Tether's Ethereum USDT — not Tether-issued) on **Optimism, zkSync, Sonic, Linea, Injective, Mantle, Scroll**; and **Binance-Peg** (18-dp) on **BNB**. The on-chain `symbol()` may read `USDT`, `USD₮`, `USDt`, or `USD₮0`; all resolve via `token: 'USDT'`.
- **Receiver setup:** none — any `0x…` address receives ERC-20 or native immediately.
- **Any other EVM chain:** pass a viem `Chain` or `{ id, rpcUrl }` + `token: { address, decimals }`.

### Solana
- **Pay in:** `'native'` (SOL), `'USDC'`, `'USDT'`, or `{ mint, decimals }`.
- **Receiver setup:** none — the payer's transaction idempotently creates the recipient's token account and pays its ~0.00204 SOL rent. **Pass the recipient's wallet address as `payTo`, not a token-account address.**
- **Payer:** needs SOL for gas + a funded source token account for the SPL token.

### Sui
- **Pay in:** `'native'` (SUI), `'USDC'`, or `{ coinType, decimals }`. **No built-in USDT** (only Wormhole-bridged exists — supply it as a custom coin if needed).
- **Receiver setup:** none — any `0x…` (32-byte) Sui address receives immediately.
- **Payer:** needs SUI for gas even when paying USDC, and must already hold a coin object of the asset.

---

## ⚠️ Chains with caveats — read before shipping

### NEAR — native is zero-setup; tokens need `storage_deposit`
- **Native NEAR works and is the easy path.** `token: 'native'` pays in NEAR (24dp) via
  digest-binding (like EVM/Solana/Sui) — **no `storage_deposit`, no receiver setup**, and a
  transfer even **creates a fresh implicit recipient**. Use it when price volatility is fine
  and you want zero setup. *(NEAR is the volatile gas coin; for stable pricing pay in a token.)*
- **Tokens (USDC/USDT/custom NEP-141) need `storage_deposit` (NEP-145).** Before an account
  can *receive* a token, it must be storage-registered on **that exact token contract** — a
  one-time ~0.00125 NEAR call, **per account per token** (else the payer's `ft_transfer`
  panics). Both the **merchant (`payTo`)** and the **payer** must be registered on the token.
  Pay in a token via `'USDC'`, `'USDT'`, or a custom `{ contractId, decimals }`.
- **Wallet:** `{ accountId, privateKey }` — NEAR needs *both* an account id and an `ed25519:…` secret key (not just a private key).
- **Implicit accounts** (64-hex) don't exist until funded with NEAR — fund the account first (a native payment to one *creates* it).
- **Built-in USDC is Circle's native contract** (`17208628…36133a1`), **not** the bridged `…factory.bridge.near` (USDC.e). Don't confuse them.
- **Do not route through NEAR Intents/solvers** — that re-introduces a third-party facilitator. PipRail uses plain transfers + local receipt verification on purpose.

### TON — USD₮ (or native TON), and you need an API-keyed RPC
- **Built-in token is USD₮ only** — **native USDC does not exist on TON** (Circle doesn't issue it; `token: 'USDC'` throws). Pay in `'USDT'`, `'native'` (Toncoin), or a custom jetton `{ master, decimals }`.
- **An RPC API key is effectively required.** The default keyless toncenter endpoint is rate-limited (~1 req/s) and will stall `confirm()`/`verify()` (they poll + read archival history). Use a keyed, archival-capable endpoint and **put the key in the URL**:
  ```ts
  requirePayment({ chain: 'ton', token: 'USDT', amount: '0.05', payTo,
    rpcUrl: 'https://toncenter.com/api/v2/jsonRPC?api_key=YOUR_KEY' })
  ```
  (Free keys: message **@tonapibot** on Telegram, or sign up at toncenter.com.)
- **Receiver setup:** none — the payer's attached gas (~0.05 TON, leftover refunded) auto-deploys the merchant's jetton wallet on first receipt. The payer needs Toncoin for gas even when paying USD₮.
- **Async settlement:** value crosses contracts, so a credit can take seconds to appear; the proof is a locator (`ton:<jetton-wallet>|<nonce>`), not a tx hash, and the nonce rides in the transfer comment to bind it.
- **Wallet:** a 24-word `{ mnemonic }` (or `{ keyPair }`), wallet version `v4` (default) or `v5r1` — must match the version your funded address was created with.

### Tron — USD₮ (or native TRX), and gas is real money
- **Pay in:** `'USDT'` (built in), **`'native'` (TRX, digest-bound)**, or a custom TRC-20 `{ address, decimals }`. **No built-in USDC** (Circle discontinued native USDC on Tron). USD₮ is the default (TRX is volatile gas); native TRX is there for completeness — a plain TransferContract, verified by txid + recency + single-use.
- **Gas is expensive and paid in TRX.** A USD₮ transfer burns Energy (~30k unstaked ≈ several TRX). The payer must hold **TRX as well as USDT**. Use `client.estimateCost(url)` to budget payment + TRX gas. (Tip for tiny test sends: rent energy from a service like TronZap/feee.io for ~1–2 TRX instead of burning ~27.) A first **native** TRX payment to a brand-new recipient also pays Tron's ~1 TRX account-creation fee (sender side).
- **Finality is slow-ish:** verification waits for the tx to solidify (~19 blocks, ~57s); until then it reads as `tx_not_found` and is retried.
- **Wallet:** `{ privateKey }` (32-byte hex, same format as EVM); addresses are Base58 `T…`.

### Algorand — USDC needs a one-time ASA opt-in (native ALGO doesn't)
- **Pay in:** `'native'` (ALGO, the zero-setup path), `'USDC'`, or a custom ASA `{ assetId, decimals }`. **USDC only for the stablecoin** — Tether deprecated/froze USDT on Algorand (2025-09-01), so it's not built in (pass it as a custom ASA if you must).
- **Receiving USDC needs an ASA opt-in.** Before an account can *receive* USDC (ASA `31566704`) — or any ASA — it must **opt into that asset** once: a 0-amount asset-transfer to itself, which raises its minimum balance by 0.1 ALGO (locked, recoverable). No opt-in → the payment fails and PipRail returns `RECIPIENT_NOT_READY`. **Native ALGO needs no opt-in.** The payer is implicitly opted-in if it already holds USDC. The one-time opt-in is plain `algosdk` (PipRail stays a payments SDK, not a wallet manager):
  ```ts
  import algosdk from 'algosdk'
  const algod = new algosdk.Algodv2('', 'https://mainnet-api.algonode.cloud', '')
  const sp = await algod.getTransactionParams().do()
  const optIn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: account.addr, receiver: account.addr, amount: 0, assetIndex: 31566704, suggestedParams: sp,
  })
  await algod.sendRawTransaction(optIn.signTxn(account.sk)).do() // one-time, per account per ASA
  ```
- **Fast + cheap:** ~3s single-step finality, flat 0.001 ALGO min fee. The challenge nonce rides in the transaction's **note field** (Template A), so the proof is bound to its challenge; verify reads the merchant account's inbound transfers via the indexer.
- **x402:** Algorand's `exact` scheme is part of the official x402 standard, but the incumbent on-chain path uses a hosted **facilitator** — PipRail is the **backendless, no-facilitator** option (payer broadcasts, merchant verifies locally).
- **Wallet:** `{ mnemonic }` (a 25-word Algorand recovery phrase) or `{ account }` (an algosdk `{ addr, sk }`).
- **Endpoints:** `rpcUrl` overrides the **algod** endpoint (submit/params); the verify-side **indexer** uses the public AlgoNode default (override needs are rare; the public indexer is production-grade for the inbound-transfer read).

### Stellar — the receiver needs a trustline + a funded account
- **Pay in:** `'native'` (XLM), `'USDC'`, `'EURC'`, or a custom `{ issuer, code, decimals }`.
- **Receiving an issued asset needs a one-time TRUSTLINE.** The merchant (`payTo`) must (1) **exist** on-chain (funded above the ~1 XLM base reserve) and (2) hold a **trustline** (`changeTrust`) for that exact `code+issuer` *before* it can receive. No trustline → the payment fails. Each trustline locks **+0.5 XLM** of reserve. The **payer** likewise needs its own trustline to hold/send the asset.
- **Accounts must exist:** this driver sends a payment, it does **not** create accounts — both ends must already be funded above reserve.
- **Reserves are locked, not spent** — recoverable.
- **Wallet:** `{ secret }` (an `S…` Ed25519 seed) or `{ keypair }`.

### XRP Ledger — the receiver needs activation + a trustline
- **Pay in:** `'native'` (XRP), `'USDC'`, `'RLUSD'`, or a custom `{ issuer, currencyHex, decimals }`. **No built-in USDT** on XRPL.
- **Receiving an IOU needs activation + a TRUSTLINE.** The merchant (`payTo`) must be an **activated** account (holding the ~1 XRP base reserve) **and** hold a **trustline** to the issuer's currency before its first IOU payment — otherwise it fails. Native XRP needs no trustline. The payer must be activated + trustlined too.
- **Reserves locked, not spent** (~1 XRP base + an owner reserve per trustline) — recoverable.
- **RLUSD** requires a DestinationTag; the SDK sets a nonce-derived one automatically.
- **Wallet:** `{ seed }` (an `s…` family seed) or `{ wallet }`.

---

## Errors you'll see — and what they actually mean

A payment that "won't go through" is almost always a **chain requirement**, not an SDK bug.
PipRail maps every such case to a typed error (stable `.code`) with a plain-language fix, and
**echoes the raw chain code** in the message + keeps the original on `err.cause`. The two you'll
meet in practice:

**`INSUFFICIENT_FUNDS`** — the **payer** can't cover it → fund the payer (token, native gas, or
the chain's reserve).

**`RECIPIENT_NOT_READY`** — the **recipient** (`payTo`) isn't set up to receive on this chain yet.
Fix the *recipient*, not the payer:

| You see (raw → mapped) | Chain | What it means | Fix |
|---|---|---|---|
| `tecNO_DST_INSUF_XRP` / `tecNO_DST` | XRPL | the `payTo` account isn't activated (an XRPL account needs ≥1 XRP base reserve to exist) | send the recipient ≥1 XRP to activate it |
| `tecNO_LINE` / `tecPATH_DRY` | XRPL | recipient has no trustline for the IOU (USDC/RLUSD) | add the trustline on the recipient |
| `tecDST_TAG_NEEDED` | XRPL | recipient requires a DestinationTag (PipRail sets one automatically) | — |
| `op_no_destination` | Stellar | the `payTo` account doesn't exist | create it with ≥1 XLM (base reserve) |
| `op_no_trust` | Stellar | recipient has no trustline for the asset | add the trustline (+0.5 XLM reserve) |
| `… is not registered` | NEAR | recipient isn't `storage_deposit`-registered on the token | call `storage_deposit` once (~0.00125 NEAR) |
| `must optin` / `asset … missing from <payTo>` | Algorand | recipient hasn't opted into the USDC ASA | opt the recipient into the ASA once (0-amount self-transfer, +0.1 ALGO min balance) |

Everything else (EVM, Solana, Sui, Tron, native TON/NEAR) needs no recipient setup, so you'll
only ever see `INSUFFICIENT_FUNDS` there if the payer is short. Full taxonomy: **[ERRORS.md](./ERRORS.md)**.

---

## How the proof is bound (for the security-curious)

Every chain proves the *same* facts locally (succeeded · recent · moved ≥ amount of the
right asset to `payTo`), but binds the proof to your challenge differently:

- **Memo-bound** (the challenge nonce is written on-chain): **NEAR tokens** (ft_transfer
  memo), **TON** (transfer comment), **Stellar** (`MEMO_HASH = sha256(nonce)`), **XRPL**
  (Memo + a derived DestinationTag), **Algorand** (the transaction's note field — native ALGO
  and USDC alike).
- **Digest-bound** (no on-chain nonce; the proof is the tx id, made single-use by the gate
  + a recency window): **EVM**, **Solana**, **Sui**, **Aptos**, **Tron**, and **native NEAR**. For
  these, a persistent `isUsed`/`markUsed` store + a tight `maxTimeoutSeconds` are
  load-bearing in multi-instance deployments (the default used-set is single-process).

(So NEAR uses *both*: its NEP-141 token path is memo-bound, while native NEAR is digest-bound.)

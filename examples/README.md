# PipRail SDK — runnable examples + live tests

Real merchant + real agent + a real local blockchain. No mocks.

## Setup (once)

```bash
# from the repo root
npm install            # links @piprail/sdk into these examples
npm run build:sdk      # build the SDK the examples import
```

You also need [Foundry](https://book.getfoundry.sh/) for `anvil` (a local
EVM chain) — `curl -L https://foundry.paradigm.xyz | bash && foundryup`.

## Watch it work, step by step

**Terminal 1 — a local blockchain:**
```bash
anvil
```

**Terminal 2 — your paid API:**
```bash
cd examples
node merchant.mjs
# merchant listening on http://127.0.0.1:4021
```

**Terminal 3 — see the protocol on the wire, then pay:**
```bash
# 1. Ask without paying → you get HTTP 402 + a price quote
curl -i http://127.0.0.1:4021/report

# 2. Let an agent pay automatically and fetch the data
cd examples && node agent.mjs
```

You'll see the agent receive the 402, send one on-chain transaction, and get
back `200` with the report. Terminal 2 prints `✅ paid` when it verifies.

## One-shot automated tests

```bash
# (with anvil running)
cd examples
node e2e.mjs          # native ETH payment: 402 → pay → 200 + replay rejection

# ERC-20 (USDC) payment — deploy the mock token first:
forge create MockUSDC.sol:MockUSDC \
  --rpc-url http://127.0.0.1:8545 \
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
  --broadcast --constructor-args 1000000000000
TOKEN=<deployed address> node e2e-erc20.mjs
```

## How it works

PipRail is the [x402](https://github.com/coinbase/x402) "402 Payment Required"
flow, verified locally with no backend:

1. **Agent requests** a gated URL.
2. **Server replies `402`** with a challenge — price, token, chain, your
   `payTo` address, a nonce — in the `payment-required` header + JSON body.
   (`requirePayment` does this; your handler never ran.)
3. **Agent pays on-chain** — one token/native transfer straight to `payTo` —
   and **retries** the same request with the transaction hash in a
   `payment-signature` header. (`PipRailClient.fetch` does this for you.)
4. **Server verifies that transaction against its own RPC** — it succeeded,
   has enough confirmations, moved the right amount of the right token to
   `payTo`, and is recent. If good, your handler runs and returns **`200`**
   with the data, plus a `payment-response` receipt header. The same tx can't
   be redeemed twice.

`requirePayment` is the **accept** side; `PipRailClient` is the **pay** side.
Same protocol, opposite ends — an app can use both.

> The keys here are Anvil's public test accounts. Never use a real private
> key in code like this.

# Chain support & per-chain setup

> ### 📖 This reference now lives at → **[docs.piprail.com/chains](https://docs.piprail.com/chains/overview/)**
> The docs are the single, always-current **source of truth**: every chain, its built-in tokens, and the per-chain receive prerequisites — one page per family.

The chains with a setup step before a wallet can pay or receive are **NEAR** (`storage_deposit`), **TON**, **Stellar** & **XRPL** (trustline + activated account), **Tron**, and **Algorand** (USDC ASA opt-in). Read your chain's page before you ship it:

- **[Chains overview — EVM & any other chain](https://docs.piprail.com/chains/overview/)** (token coverage, provenance, BYO-chain)
- [Solana](https://docs.piprail.com/chains/solana/) · [TON](https://docs.piprail.com/chains/ton/) · [Tron](https://docs.piprail.com/chains/tron/) · [NEAR](https://docs.piprail.com/chains/near/) · [Sui](https://docs.piprail.com/chains/sui/) · [Aptos](https://docs.piprail.com/chains/aptos/) · [Algorand](https://docs.piprail.com/chains/algorand/) · [Stellar](https://docs.piprail.com/chains/stellar/) · [XRP Ledger](https://docs.piprail.com/chains/xrpl/)

**Source of record:** the chain set itself is defined in code under [`src/drivers/`](src/drivers/) (`src/drivers/evm/chains.ts` for the EVM presets). The docs mirror it; this file is a signpost.

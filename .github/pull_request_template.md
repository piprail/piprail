<!-- Thanks for contributing to PipRail! Keep it dead simple — the simplicity is the product. -->

## What & why

<!-- What does this change, and why? Link any related issue (e.g. Closes #12). -->

## Type of change

- [ ] Bug fix
- [ ] New feature (opt-in; defaults unchanged)
- [ ] New chain / preset / token
- [ ] Docs / site
- [ ] Refactor / chore

## Checklist

- [ ] `npm run typecheck` passes
- [ ] `npm run test:sdk` passes (tests changed first — tests are the contract)
- [ ] `npm run build:sdk` passes
- [ ] No backend, database, auth, dashboard, or fee was added
- [ ] Protocol layer stays chain-agnostic (no `viem`/`@solana`/etc. in `server.ts`/`client.ts`/`x402.ts`)

### If this adds a chain / family / token

- [ ] Every token address verified **on-chain** (exists, symbol + decimals match)
- [ ] Driver mirrors the existing family templates (`chains`/`wallet`/`pay`/`verify`/`index`)
- [ ] Lazy-chunk invariant holds (pure-EVM bundle has no static import of the new lib)
- [ ] The chain is on **piprail.com** (`site/` + logo SVG in `site/public/chains/`)

## Sign-off

- [ ] I agree to the DCO (`Signed-off-by:` in my commits — see CONTRIBUTING.md). No CLA.

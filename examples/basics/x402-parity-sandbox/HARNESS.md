# Break-it harness primer (x402-parity-sandbox)

This sandbox tests the **PUBLISHED** `@piprail/sdk@2.14.1` + `@piprail/mcp@0.9.0` npm artifacts —
NOT the workspace build. `lib/env.mjs` throws if `@piprail/sdk` resolves outside this folder, so
every suite imports the bare specifier `@piprail/sdk` and gets the real published package.

## How to write a suite

A suite is one `.mjs` file in `suites/` named `NN-<name>.mjs` (NN ≥ 06; 01–05 already exist).
`run-all.mjs` auto-discovers any `^\d.*\.mjs$`. End every suite with `done('NN <name>')`.

```js
import { createPaymentGate, /* … */ } from '@piprail/sdk'
import { check, banner, group, note, skip, done } from '../lib/report.mjs'
import { loadWallet, merchantKey, RPC, USDC, pub, usdcBalance, getAddress, formatUnits, DUMMY_KEY } from '../lib/env.mjs'
import { serveGate } from '../lib/http-gate.mjs'

banner('NN · TITLE')
// …offline assertions: check(cond, 'message')…
done('NN title')
```

### Harness API
- `check(cond, msg)` — asserts; logs ✓/✗ and flips the process exit code on failure. Returns the bool.
- `banner/group/note/skip` — section headers + a yellow skip line. `done(label)` — prints the verdict and `process.exit(0|1)`.
- `loadWallet()` → `{ payer, merchant, key, mnemonic }` or `null` (absent on a fresh clone). `merchantKey(w)` → the acct1 (payTo) private key.
- `RPC`, `USDC`, `pub` (a viem Base public client), `usdcBalance(addr)`, `ethBalance(addr)`, `getAddress`, `formatUnits`, `DUMMY_KEY` (a never-funded `0x11..` key for offline shape checks).
- `serveGate(gate, { port, path, body, onVerify })` → `{ server, url, listen, close, lastSig, lastResp }`.

### LIVE legs
Gate every on-chain leg behind **both** `loadWallet() !== null` **and** `process.env.PIPRAIL_LIVE === '1'`.
The serial live pass runs with `PIPRAIL_LIVE=1`; parallel authoring runs without it, so authoring is
money-free and free of EOA-nonce races. Most break-it value is OFFLINE — favour it.

### Rules
- Create exactly one new file. Never edit `package.json`, `run-all.mjs`, `lib/*`, or suites 01–05.
- Every `parse*`/read method that the SDK contracts as "never throws" MUST be asserted to return a
  verdict/`null` instead of throwing — wrap in try/catch and FAIL the suite if it throws.
- Run offline before finishing: `node <abs>/suites/NN-<name>.mjs` must exit 0, unless a failing
  `check` exposes a genuine published-artifact bug (keep it, and report it).

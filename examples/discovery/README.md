# Discovery example

A 402 endpoint is payable, but nobody can *find* it. PipRail closes that gap with **$0 and no
backend** — built on the **open** x402 indexes (402 Index, CDP Bazaar). PipRail hosts no registry of
its own. Three moves, three scripts:

```bash
npm install
npm run emit       # turn your gate's config into the files crawlers read (pure, no network)
npm run discover   # find payable APIs on the open indexes (live, read-only — no wallet spend)
npm run register   # list an endpoint you run on 402 Index (live, no auth, any chain)
```

| Script | Function(s) | What it does | Network? |
|---|---|---|---|
| `emit` | `gate.describe`, `buildOpenApi`, `buildWellKnownX402`, `buildX402DnsTxt` | Serializes your gate into an OpenAPI 3.1 doc (with `x-payment-info` + an `x-generator` stamp), a `/.well-known/x402` file, and a `_x402` DNS record. Serve them on your own origin. | none (pure) |
| `discover` | `client.discover` | Reads the open indexes and returns payable resources. `NETWORK=self` filters to your chain; `any` searches all. | read-only |
| `register` | `client.register` | Lists your endpoint on 402 Index (no auth, no signature, any chain). The index probes the URL and only lists real `402` endpoints. | write (lists a URL; moves no funds) |

### Env

| Var | Used by | Default |
|---|---|---|
| `ORIGIN` / `PAY_TO` | `emit` | `https://api.example.com` / a placeholder address |
| `QUERY` / `NETWORK` | `discover` | `api` / `any` |
| `URL` | `register` | `https://example.com` (a non-402 URL, so a no-arg run safely shows the index's probe + rejection — pass your own deployed 402 URL to really list it) |

> **Safe by design.** `discover` is a pure read. `register` lists only endpoints that actually return
> `402` (the index probes them), and the default `URL` is intentionally *not* a 402 endpoint, so running
> it with no args demonstrates the graceful rejection rather than creating a listing. Nothing here spends
> funds. Full reference: [`../../sdk/DISCOVERY.md`](../../sdk/DISCOVERY.md).

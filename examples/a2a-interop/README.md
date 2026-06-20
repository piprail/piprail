# a2a-interop — prove PipRail's A2A envelopes are x402-V2-conformant

A reproducible cross-check of PipRail's A2A (Google Agent2Agent) seller transport against
**Google's actual x402 libraries** — not just the spec text. It answers, with running code:

1. Do PipRail's `x402.payment.*` metadata keys + the extension URI match Google's official
   `x402_a2a` constants? (**yes** — identical)
2. Do PipRail's `PaymentRequired` + `PaymentPayload` envelopes validate against the **current**
   `x402` V2 schema? (**yes** — byte-identical core fields)
3. What does the **legacy** `x402-a2a` 0.1.0 package expect, and why is it stale? (V1 schema:
   chain slugs, `maxAmountRequired`, `x402Version: 1`; currently un-importable on the live stack)

**Verdict:** PipRail's A2A seller transport is conformant with the **current x402 standard (V2)** and
uses the **exact** A2A extension keys + URI as Google's official `x402_a2a`. The legacy v0.1 `x402-a2a`
package targets the older V1 schema and is bitrotted — PipRail tracks the live standard, not that
frozen snapshot. (Seller-side only; the A2A buyer + AP2 carriage are deferred.) The release notes for
this change are in [`sdk/CHANGELOG.md`](../../sdk/CHANGELOG.md) (2.11.0).

## Run it

Needs [`uv`](https://docs.astral.sh/uv/) (manages its own Python) and Node. From the repo root:

```bash
# 1. dump PipRail's actual A2A envelopes (resolves @piprail/sdk from the workspace)
node examples/a2a-interop/dump-envelopes.mjs      # → /tmp/pr-required.json + /tmp/pr-payload.json

# 2a. CURRENT-standard conformance (the one that matters) — x402 2.13.1 (V2)
uv venv --python 3.12 /tmp/a2a-v2 && uv pip install --python /tmp/a2a-v2 x402==2.13.1
/tmp/a2a-v2/bin/python examples/a2a-interop/interop_probe.py

# 2b. (optional) legacy characterization — x402-a2a 0.1.0 needs its contemporaries pinned
git clone --depth 1 https://github.com/google-agentic-commerce/a2a-x402 /tmp/a2a-x402-ref
uv venv --python 3.12 /tmp/a2a-legacy
uv pip install --python /tmp/a2a-legacy -e /tmp/a2a-x402-ref/python/x402_a2a 'x402==0.3.0' 'a2a-sdk==0.2.16'
/tmp/a2a-legacy/bin/python -c "from x402_a2a import X402_EXTENSION_URI, x402Metadata; print(X402_EXTENSION_URI, x402Metadata.STATUS_KEY)"
```

> The durable, CI-friendly guard for the same property (no Python needed) is the SDK test
> `sdk/test/transports/a2a-wire-conformance.test.ts`, which pins the exact x402-V2 wire shape so a
> regression to v1 field names or a version flip is caught on every run.

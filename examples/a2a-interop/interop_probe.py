"""Validate PipRail's A2A envelopes against the CURRENT x402 V2 schema (Google's canonical lib).

Run with a Python that has `x402` (V2) installed — see this folder's README:
    uv venv --python 3.12 /tmp/a2a-v2 && uv pip install --python /tmp/a2a-v2 x402==2.13.1
    node examples/a2a-interop/dump-envelopes.mjs
    /tmp/a2a-v2/bin/python examples/a2a-interop/interop_probe.py

Exits non-zero if PipRail drifts from the x402 V2 wire schema.
"""
import json
import sys

from x402.schemas.payments import PaymentRequired, PaymentPayload

failures = 0


def check(cond, msg):
    global failures
    print(("  [PASS] " if cond else "  [FAIL] ") + msg)
    if not cond:
        failures += 1


print("=== PipRail A2A envelopes vs the current x402 V2 schema ===")

ours = json.load(open("/tmp/pr-required.json"))
pr = PaymentRequired.model_validate(ours)  # raises if the envelope isn't V2-shaped
check(pr.x402_version == 2, f"PaymentRequired.x402Version == 2 (got {pr.x402_version})")
schemes = [a.scheme for a in pr.accepts]
check("exact" in schemes, f"offers an `exact` rail a standard client can pay (schemes: {schemes})")

exact = next(a for a in pr.accepts if a.scheme == "exact")
our_exact_in = next(a for a in ours["accepts"] if a["scheme"] == "exact")
check(exact.amount == our_exact_in["amount"], "exact.amount preserved (V2 `amount`, not `maxAmountRequired`)")
check("eip155:" in exact.network, f"CAIP-2 network preserved (got {exact.network})")

# round-trip the exact rail by alias and diff the core fields
reser = pr.model_dump(by_alias=True, exclude_none=True)
re_exact = next(a for a in reser["accepts"] if a["scheme"] == "exact")
our_exact = next(a for a in ours["accepts"] if a["scheme"] == "exact")
core = ["scheme", "network", "asset", "amount", "payTo", "maxTimeoutSeconds"]
check(all(re_exact.get(k) == our_exact.get(k) for k in core), "exact rail core fields round-trip byte-identical")

payload = json.load(open("/tmp/pr-payload.json"))
pp = PaymentPayload.model_validate(payload)
check(pp.x402_version == 2, f"PaymentPayload.x402Version == 2 (got {pp.x402_version})")
check(pp.get_scheme() == "exact", "payload scheme (nested under `accepted`) == exact")

print("\n" + ("ALL PASS — PipRail is x402-V2 conformant" if failures == 0 else f"{failures} FAILURE(S)"))
sys.exit(1 if failures else 0)

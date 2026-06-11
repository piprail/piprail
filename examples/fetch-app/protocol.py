"""Fetch Agent Payment Protocol (APP) — the message models, plus the PipRail method.

APP is a uAgents *message spec*: the payee asks for payment, the payer commits,
the payer completes with proof. It standardizes the *negotiation* and delegates
*settlement* to a ``payment_method``. Fetch ships ``skyfire`` and ``fet_direct``;
this adds ``x402`` (a.k.a. ``piprail``) — backendless, multi-chain, stablecoin.

These mirror the public APP fields so the demo agents drop into a real uAgent.
Confirm against ``uagents.fetch.ai/docs/guides/agent-payment-protocol`` before you
file the upstream proposal — field names there are authoritative.
"""

from __future__ import annotations

from typing import Optional

from uagents import Model

# The value we propose for APP's `payment_method`. PipRail settles it over x402.
X402_PAYMENT_METHOD = "x402"


class RequestPayment(Model):
    """Payee → payer: "pay me, here's how."

    For ``payment_method == "x402"`` the ``reference`` is the URL of a PipRail-gated
    resource the payer settles; ``currency`` is the token symbol (USDC / USDT / EURC
    / FDUSD / USD1 / …) and ``chain`` is the optional preferred chain.
    """

    amount: str
    currency: str
    payment_method: str = X402_PAYMENT_METHOD
    reference: str = ""  # x402 resource URL (the thing the payer pays)
    chain: Optional[str] = None
    memo: Optional[str] = None


class CommitPayment(Model):
    """Payer → payee: "I'll pay it." (Optional ack before settling.)"""

    reference: str
    accepted: bool = True


class RejectPayment(Model):
    """Payer → payee: "I won't pay it." (e.g. over budget / wrong chain.)"""

    reference: str
    reason: str = ""


class CompletePayment(Model):
    """Payer → payee: "paid — here's the proof."

    ``proof`` is PipRail's x402 receipt
    (``{transaction, network, asset, amount, payer, payTo, verifiedAt}``). The payee
    needs no out-of-band verify: its own PipRail gate already verified the proof
    locally and served the result when the payer settled. This is the receipt of record.
    """

    reference: str
    proof: dict
    transaction: str = ""  # the on-chain tx id, lifted out of `proof` for convenience


class CancelPayment(Model):
    """Either side: "abort this exchange."""

    reference: str
    reason: str = ""

"""The PAYEE uAgent — sells a service, settled over PipRail (x402).

It fronts a PipRail gate (``merchant.mjs``): it reads that gate's ``/offer`` to learn
the price + the resource URL, asks the payer for payment via APP ``RequestPayment``,
and finalizes on ``CompletePayment``. It does NOT re-verify the proof — its own gate
already verified it locally and served the result when the payer settled. The
``CompletePayment`` is the receipt of record for the negotiation.

    # 1) start the gate (separate shell):  PAY_TO=0x… PIPRAIL_CHAIN=bnb npm run merchant
    # 2) start the payee agent:
    pip install -r requirements.txt
    PAYER_ADDRESS=agent1q… MERCHANT_OFFER=http://127.0.0.1:4021/offer python3 payee_agent.py
"""

from __future__ import annotations

import os
import urllib.request

from uagents import Agent, Context

from protocol import CancelPayment, CompletePayment, RejectPayment, RequestPayment

# Where the payer agent listens (its address, printed when payer_agent.py starts).
PAYER_ADDRESS = os.environ.get("PAYER_ADDRESS", "")
# The gate's /offer endpoint — the source of truth for price + resource URL.
MERCHANT_OFFER = os.environ.get("MERCHANT_OFFER", "http://127.0.0.1:4021/offer")

payee = Agent(
    name="piprail-payee",
    seed=os.environ.get("PAYEE_SEED", "piprail-fetch-app-payee-demo-seed"),
    port=8102,
    endpoint=["http://127.0.0.1:8102/submit"],
)


def _read_offer() -> dict:
    """Read {amount, currency, chain, reference} straight from the PipRail gate."""
    with urllib.request.urlopen(MERCHANT_OFFER, timeout=10) as resp:  # noqa: S310 (localhost demo)
        import json

        return json.loads(resp.read().decode())


@payee.on_event("startup")
async def kick_off(ctx: Context) -> None:
    if not PAYER_ADDRESS:
        ctx.logger.warning("set PAYER_ADDRESS to the payer agent's address to start the exchange")
        return
    offer = _read_offer()
    ctx.logger.info(f"requesting {offer['amount']} {offer['currency']} for {offer['reference']}")
    await ctx.send(
        PAYER_ADDRESS,
        RequestPayment(
            amount=str(offer["amount"]),
            currency=str(offer["currency"]),
            reference=str(offer["reference"]),
            chain=offer.get("chain"),
        ),
    )


@payee.on_message(model=CompletePayment)
async def on_complete(ctx: Context, _sender: str, msg: CompletePayment) -> None:
    # The gate already verified + served the result; this is just the receipt log.
    ctx.logger.info(f"✅ settled — tx {msg.transaction or msg.proof.get('transaction', '?')}")
    ctx.logger.info(f"   asset={msg.proof.get('asset')} amount={msg.proof.get('amount')} payTo={msg.proof.get('payTo')}")


@payee.on_message(model=RejectPayment)
async def on_reject(ctx: Context, _sender: str, msg: RejectPayment) -> None:
    ctx.logger.warning(f"payer declined: {msg.reason}")


@payee.on_message(model=CancelPayment)
async def on_cancel(ctx: Context, _sender: str, msg: CancelPayment) -> None:
    ctx.logger.warning(f"exchange cancelled: {msg.reason}")


if __name__ == "__main__":
    payee.run()

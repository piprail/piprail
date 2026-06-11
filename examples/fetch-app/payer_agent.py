"""The PAYER uAgent — settles APP RequestPayments over PipRail (x402).

On a ``RequestPayment`` whose ``payment_method`` is ``x402``, it hands the
``reference`` URL to the PipRail bridge (``@piprail/mcp`` → ``piprail_pay_request``),
which pays the cheapest *settleable* rail under its spend policy, then replies
``CompletePayment`` with the proof. A policy refusal or shortfall → ``RejectPayment``.

The wallet, chain, and budget live in env (see ``.env.example``) — never in code.
On BNB, picking FDUSD/USD1 makes the buyer signature gasless (EIP-3009, no approve).

    pip install -r requirements.txt
    PIPRAIL_PRIVATE_KEY=0x… PIPRAIL_CHAIN=bnb python3 payer_agent.py
"""

from __future__ import annotations

import os

from uagents import Agent, Context

from piprail_bridge import PipRailBridge
from protocol import (
    CompletePayment,
    RejectPayment,
    RequestPayment,
    X402_PAYMENT_METHOD,
)

payer = Agent(
    name="piprail-payer",
    seed=os.environ.get("PAYER_SEED", "piprail-fetch-app-payer-demo-seed"),
    port=8101,
    endpoint=["http://127.0.0.1:8101/submit"],
)

# One long-lived bridge = one budget-bound @piprail/mcp wallet for the agent's life.
bridge = PipRailBridge()


@payer.on_event("startup")
async def _open_bridge(ctx: Context) -> None:
    bridge.start()
    ctx.logger.info(f"PipRail bridge up — tools: {[t['name'] for t in bridge.list_tools()]}")


@payer.on_event("shutdown")
async def _close_bridge(_ctx: Context) -> None:
    bridge.close()


@payer.on_message(model=RequestPayment)
async def on_request_payment(ctx: Context, sender: str, msg: RequestPayment) -> None:
    if msg.payment_method != X402_PAYMENT_METHOD:
        await ctx.send(sender, RejectPayment(reference=msg.reference, reason="unsupported payment_method"))
        return

    ctx.logger.info(f"settling {msg.amount} {msg.currency} via x402 → {msg.reference}")
    # The only money-moving call. Verification happens on the PAYEE's gate, locally.
    result = bridge.pay(msg.reference)

    if not result.get("ok"):
        reason = result.get("explain") or result.get("reason") or "payment refused"
        ctx.logger.warning(f"refused: {reason}")
        await ctx.send(sender, RejectPayment(reference=msg.reference, reason=reason))
        return

    receipt = result.get("receipt") or {}
    ctx.logger.info(f"paid — tx {receipt.get('transaction', '?')}")
    await ctx.send(
        sender,
        CompletePayment(
            reference=msg.reference,
            proof=receipt,
            transaction=receipt.get("transaction", ""),
        ),
    )


if __name__ == "__main__":
    payer.run()

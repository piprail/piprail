"""Optional ASI:One chat front-end for PipRail Pay.

Makes the relay reachable in natural language from ASI:One / the Agentverse chat:
a user says "pay https://some-x402-url for me" and this uAgent forwards the URL to
the relay (relay.mjs) and returns the result. If the relay answers 402 (fee unpaid),
it relays the human-readable price so the caller knows what to pay.

This is the discovery/chat surface; the relay is the paid x402 engine. To make the
fee auto-pay from chat, wire @piprail/mcp on the relay side (see ../fetch-app) — the
relay already settles the SPEND leg itself.

    pip install -r requirements.txt
    RELAY_PUBLIC_URL=https://your-relay python3 asi_chat_agent.py
"""

from __future__ import annotations

import os
import re
import urllib.parse
import urllib.request
from datetime import datetime
from uuid import uuid4

from uagents import Agent, Context, Protocol
from uagents_core.contrib.protocols.chat import (
    ChatAcknowledgement,
    ChatMessage,
    TextContent,
    chat_protocol_spec,
)

RELAY = os.environ.get("RELAY_PUBLIC_URL", "http://127.0.0.1:4031")
URL_RE = re.compile(r"https?://\S+")

agent = Agent(
    name="piprail-pay-chat",
    seed=os.environ.get("AGENT_SECRET_KEY", "piprail-pay-chat-demo-seed"),
    port=8031,
    mailbox=True,
    publish_agent_details=True,
)
chat = Protocol(spec=chat_protocol_spec)


def _relay_pay(target: str) -> str:
    """Ask the relay to pay an x402 URL; return a human-readable result."""
    u = f"{RELAY}/pay?url=" + urllib.parse.quote(target, safe="")
    try:
        with urllib.request.urlopen(u, timeout=60) as r:  # noqa: S310 (operator-trusted relay)
            return f"Paid and relayed ✅\n{r.read().decode()[:1200]}"
    except urllib.error.HTTPError as e:
        if e.code == 402:
            return "That endpoint needs the relay fee paid first (a 402 USDC challenge). " \
                   "Pay the fee at the relay's /pay route, then I'll return the unlocked result."
        return f"Relay error {e.code}: {e.read().decode()[:400]}"
    except Exception as e:  # noqa: BLE001
        return f"Could not reach the relay: {e}"


@chat.on_message(ChatMessage)
async def on_chat(ctx: Context, sender: str, msg: ChatMessage) -> None:
    await ctx.send(sender, ChatAcknowledgement(timestamp=datetime.now(), acknowledged_msg_id=msg.msg_id))
    text = "".join(item.text for item in msg.content if isinstance(item, TextContent))
    found = URL_RE.search(text)
    reply = (
        _relay_pay(found.group(0))
        if found
        else "I'm PipRail Pay — send me an x402 URL (e.g. 'pay https://piprail.com/x402/demo') "
        "and I'll pay it for you and return the result."
    )
    await ctx.send(
        sender,
        ChatMessage(timestamp=datetime.utcnow(), msg_id=uuid4(), content=[TextContent(type="text", text=reply)]),
    )


@chat.on_message(ChatAcknowledgement)
async def on_ack(_ctx: Context, _sender: str, _msg: ChatAcknowledgement) -> None:
    pass


agent.include(chat, publish_manifest=True)

if __name__ == "__main__":
    agent.run()

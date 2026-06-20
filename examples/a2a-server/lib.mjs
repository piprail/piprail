// Mount the PipRail A2A seller handler in a REAL @a2a-js/sdk server.
//
// PipRail's `handleMessage` returns a complete, metadata-bearing A2A Task. The @a2a-js/sdk runtime
// is event-driven and correlates events by HOST-OWNED identifiers (messageId / artifactId /
// contextId), so the executor adapter stamps those before publishing. PipRail's A2A types are
// transport-layer metadata only (zero @a2a dependency, by design) — the adapter is where the
// runtime's identifiers belong.
import { randomUUID } from 'node:crypto'
import { DefaultRequestHandler, InMemoryTaskStore } from '@a2a-js/sdk/server'
import { createPaymentGate, createA2APaymentHandler } from '@piprail/sdk'

const DEFAULT_PAYTO = '0x28Dc25bf88BF06fc0a3Af1747D1aA4a21f313ed0'

export function buildHandler({ payTo = DEFAULT_PAYTO, rpcUrl = 'https://base-rpc.publicnode.com', exact, fulfill } = {}) {
  const gate = createPaymentGate({ chain: 'base', token: 'USDC', amount: '0.01', payTo, rpcUrl, ...(exact ? { exact } : {}) })

  const pay = createA2APaymentHandler({
    gate,
    fulfill: fulfill ?? (async ({ receipt }) => [{ name: 'result', parts: [{ kind: 'text', text: `Paid ${receipt.amount} — here's your result.` }] }]),
  })

  class X402Executor {
    async execute(ctx, bus) {
      const task = await pay.handleMessage(ctx.userMessage, ctx.taskId)
      // Stamp the SDK-required, host-owned identifiers so the runtime's event correlation works.
      const msg = task.status.message
      if (msg) {
        msg.messageId ??= randomUUID()
        msg.parts ??= []
      }
      for (const a of task.artifacts ?? []) a.artifactId ??= randomUUID()
      task.contextId = ctx.contextId
      bus.publish(task)
      bus.finished()
    }
    async cancelTask() {} // PipRail holds no long-running work to cancel
  }

  const agentCard = {
    name: 'PipRail x402 Merchant',
    description: 'A paid skill, payable over A2A with x402.',
    url: 'http://localhost:4010/',
    version: '1.0.0',
    protocolVersion: '0.3.0',
    capabilities: { extensions: [pay.agentCardExtension({ required: false })] },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['application/json'],
    skills: [{ id: 'demo', name: 'Demo', description: 'A pay-gated demo skill.', tags: ['paid'] }],
  }

  return { handler: new DefaultRequestHandler(agentCard, new InMemoryTaskStore(), new X402Executor()), agentCard, gate, pay }
}

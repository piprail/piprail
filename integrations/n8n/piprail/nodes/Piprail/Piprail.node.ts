import type {
  IDataObject,
  IExecuteFunctions,
  INodeExecutionData,
  INodeType,
  INodeTypeDescription,
} from 'n8n-workflow'
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow'
import { PipRailClient } from '@piprail/sdk'
import type { ChainSelector } from '@piprail/sdk'

export class Piprail implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'PipRail',
    name: 'piprail',
    icon: { light: 'file:piprail.svg', dark: 'file:piprail.dark.svg' },
    group: ['transform'],
    version: 1,
    subtitle: '={{ $parameter["operation"] }}',
    description:
      'Pay an x402 (HTTP 402) URL from a workflow — self-custody, EVM chains, no facilitator, no fee',
    defaults: { name: 'PipRail' },
    inputs: [NodeConnectionTypes.Main],
    outputs: [NodeConnectionTypes.Main],
    // Lets n8n AI Agent nodes call this node as a tool.
    usableAsTool: true,
    credentials: [{ name: 'piprailApi', required: true }],
    properties: [
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        noDataExpression: true,
        options: [
          {
            name: 'Pay URL',
            value: 'pay',
            action: 'Pay an x402 URL',
            description:
              'Fetch a URL; if it returns HTTP 402, pay within the spend caps and return the unlocked response',
          },
          {
            name: 'Plan Payment',
            value: 'plan',
            action: 'Plan a payment',
            description: 'Read-only: can the wallet afford it, and on which rail (never pays)',
          },
          {
            name: 'Quote',
            value: 'quote',
            action: 'Quote a 402 URL',
            description: 'Read-only: the price of a gated URL (never pays)',
          },
          {
            name: 'Estimate Cost',
            value: 'estimateCost',
            action: 'Estimate the cost of a 402 URL',
            description: 'Read-only: price plus a gas estimate in the chain’s native coin (never pays)',
          },
        ],
        default: 'pay',
      },
      {
        displayName: 'URL',
        name: 'url',
        type: 'string',
        default: '',
        required: true,
        placeholder: 'https://api.example.com/paid',
        description: 'The URL to fetch (and pay, if it answers with 402)',
      },
      {
        displayName: 'Spend Caps',
        name: 'caps',
        type: 'collection',
        placeholder: 'Add cap',
        default: {},
        displayOptions: { show: { operation: ['pay'] } },
        description:
          'Hard limits enforced before any on-chain send. Bounds this execution; the agent cannot exceed them.',
        options: [
          {
            displayName: 'Max Per Payment',
            name: 'maxAmount',
            type: 'string',
            default: '',
            placeholder: '0.10',
            description: 'Ceiling for any single payment, in human units (e.g. 0.10)',
          },
          {
            displayName: 'Max Total',
            name: 'maxTotal',
            type: 'string',
            default: '',
            placeholder: '1.00',
            description: 'Lifetime ceiling for this execution, per network and asset (e.g. 1.00)',
          },
        ],
      },
    ],
  }

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData()
    const creds = await this.getCredentials('piprailApi')
    const out: INodeExecutionData[] = []

    for (let i = 0; i < items.length; i++) {
      const operation = this.getNodeParameter('operation', i) as string
      const url = this.getNodeParameter('url', i) as string
      try {
        const caps =
          operation === 'pay'
            ? (this.getNodeParameter('caps', i, {}) as { maxAmount?: string; maxTotal?: string })
            : {}
        const policy: { maxAmount?: string; maxTotal?: string } = {}
        if (caps.maxAmount) policy.maxAmount = caps.maxAmount
        if (caps.maxTotal) policy.maxTotal = caps.maxTotal

        // Wallet comes only from the n8n credential — never from the environment or filesystem.
        const client = new PipRailClient({
          chain: (((creds.chain as string) || 'base').trim()) as ChainSelector,
          wallet: { key: creds.privateKey as string },
          ...(creds.rpcUrl ? { rpcUrl: (creds.rpcUrl as string).trim() } : {}),
          ...(Object.keys(policy).length ? { policy } : {}),
          schemes: ['onchain-proof', 'exact'],
        })

        // The SDK's read-only methods return null for a non-gated URL and never throw.
        let json: IDataObject
        if (operation === 'quote') {
          json = ((await client.quote(url)) ?? { gated: false }) as unknown as IDataObject
        } else if (operation === 'plan') {
          json = ((await client.planPayment(url)) ?? { gated: false }) as unknown as IDataObject
        } else if (operation === 'estimateCost') {
          json = ((await client.estimateCost(url)) ?? { gated: false }) as unknown as IDataObject
        } else {
          const res = await client.fetch(url)
          const receipt = client.lastReceipt()
          const body = await res.text()
          let parsed: unknown
          try {
            parsed = JSON.parse(body)
          } catch {
            parsed = body
          }
          json = {
            status: res.status,
            paid: receipt != null,
            receipt: receipt ? (receipt as unknown as IDataObject) : null,
            body: parsed as IDataObject,
          }
        }

        out.push({ json, pairedItem: { item: i } })
      } catch (error) {
        if (this.continueOnFail()) {
          out.push({ json: { error: (error as Error).message }, pairedItem: { item: i } })
          continue
        }
        throw new NodeOperationError(this.getNode(), error as Error, { itemIndex: i })
      }
    }

    return [out]
  }
}

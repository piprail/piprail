import type { ICredentialType, INodeProperties } from 'n8n-workflow'

export class PiprailApi implements ICredentialType {
  name = 'piprailApi'
  displayName = 'PipRail API'
  documentationUrl = 'https://docs.piprail.com'
  properties: INodeProperties[] = [
    {
      displayName: 'Private Key',
      name: 'privateKey',
      type: 'string',
      typeOptions: { password: true },
      default: '',
      required: true,
      description:
        'Hex private key (0x…) of the wallet payments are sent from. Held as an encrypted n8n credential — never read from the environment or the filesystem.',
    },
    {
      displayName: 'Chain',
      name: 'chain',
      type: 'string',
      default: 'base',
      description:
        'EVM chain to pay on — e.g. base, ethereum, arbitrum, optimism, polygon, bnb, avalanche. (v1 is EVM-only.)',
    },
    {
      displayName: 'RPC URL',
      name: 'rpcUrl',
      type: 'string',
      default: '',
      description: 'Optional custom RPC endpoint. Leave blank to use the SDK default for the chain.',
    },
  ]
}

import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { UsageDoc } from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import type { ThinkingLevel } from '../../shared/channel-host.ts'
import { discoverAgents } from '../../lib/agents.ts'
import { readFamilies } from '../../lib/families-settings.ts'
import { refOf } from '../../lib/families.ts'
import { ContextUsageDoc } from '../conversations/api.ts'
import { usageTotals } from '../../lib/context-usage.ts'
import type { Address, telegramChannel } from './channel.ts'

export const commandMetadata = [
  { name: '/clear', description: 'Start a fresh conversation' },
  { name: '/new', description: 'Start a fresh conversation' },
  { name: '/stop', description: 'Stop the current run' },
  { name: '/compact', description: 'Compact the current context' },
  { name: '/stats', description: 'Show context use, tokens, and recorded cost' },
  { name: '/model', args: ' [preset or provider/model]', description: 'Show or change the model' },
  { name: '/thinking', args: ' [level]', description: 'Show or change the thinking level' },
  { name: '/persona', args: ' [name]', description: 'Show or change the persona' },
  { name: '/followup', args: ' <text>', description: 'Send after the current run' },
  { name: '/help', description: 'Show these commands' },
] as const
export const commands = commandMetadata.map(({ name }) => name)
type Command = (typeof commandMetadata)[number]['name']
const help = commandMetadata
  .map((item) => `${item.name}${'args' in item ? item.args : ''}: ${item.description}`)
  .join('\n')

export async function runCommand(
  host: ExtensionHost,
  channel: ReturnType<typeof telegramChannel>,
  from: Address,
  command: Command,
  text: string,
): Promise<string | undefined> {
  const arg = text.trim()
  const { conversations, models } = host.channelHost()
  if (command === '/help') return help
  if (command === '/clear' || command === '/new')
    return (await channel.clear(from)) ? 'Started a fresh conversation.' : undefined
  if (command === '/followup') {
    if (!arg) return 'Use /followup <text>.'
    await channel.submit(from, arg, 'followUp')
    return undefined
  }
  const id = await channel.current(from)
  if (id === undefined) return 'Send a message or use /new to start a conversation.'

  switch (command) {
    case '/stop':
      await conversations.stop(id)
      return 'Stopped the active run.'
    case '/compact':
      await conversations.compact(id, {})
      return 'Compaction requested.'
    case '/stats': {
      const [usage, window] = await Promise.all([
        host.harness().snapshot(UsageDoc, id as ConversationId, context),
        host.harness().snapshot(ContextUsageDoc, id as ConversationId, context),
      ])
      const totals = usageTotals(usage ?? { models: {}, tools: {} })
      const used =
        window?.tokens === undefined
          ? 'not available'
          : `${window.estimated ? 'about ' : ''}${window.tokens}${window.window === undefined ? '' : ` / ${window.window}`} tokens`
      return `Context: ${used}\nInput: ${totals.input} tokens\nOutput: ${totals.output} tokens\nCache read: ${totals.cacheRead} tokens\nCache write: ${totals.cacheWrite} tokens\nRecorded cost: $${totals.cost.toFixed(4)}`
    }
    case '/model': {
      if (arg) {
        const model = refOf(arg)
        const next = await conversations.configure(id, model ? { model } : { preset: arg })
        return `Model: ${modelName(next.model)}${next.preset ? ` (preset ${next.preset})` : ''}`
      }
      const { configuration } = await conversations.get(id)
      const { families } = await readFamilies(host.userHome, host.projectRoot)
      const available = (await models.list()).filter((model) => model.available)
      return `Model: ${modelName(configuration.model)}${configuration.preset ? ` (preset ${configuration.preset})` : ''}\nPresets: ${Object.keys(families).join(', ')}\nAvailable models: ${available.map((model) => `${model.provider}/${model.id}`).join(', ') || 'none'}`
    }
    case '/thinking': {
      if (arg) {
        const next = await conversations.configure(id, { thinkingLevel: arg as ThinkingLevel })
        return `Thinking: ${next.thinkingLevel ?? 'off'}`
      }
      const { configuration } = await conversations.get(id)
      const model = (await models.list()).find(
        (candidate) =>
          candidate.provider === configuration.model?.provider &&
          candidate.id === configuration.model.modelId,
      )
      return `Thinking: ${configuration.thinkingLevel ?? 'off'}\nLevels: ${model?.thinkingLevels.join(', ') || 'none'}`
    }
    case '/persona': {
      if (arg) {
        const next = await conversations.configure(id, { definition: arg === 'none' ? null : arg })
        return `Persona: ${next.definition ?? 'none'}`
      }
      const { configuration } = await conversations.get(id)
      const { definitions } = await discoverAgents(
        host.ultimateRoot,
        host.projectRoot,
        host.userHome,
        host.modelRuntime,
      )
      return `Persona: ${configuration.definition ?? 'none'}\nAvailable personas: ${definitions.map(({ name }) => name).join(', ') || 'none'}`
    }
  }
  return undefined
}

function modelName(model: { provider: string; modelId: string } | undefined) {
  return model ? `${model.provider}/${model.modelId}` : 'none'
}

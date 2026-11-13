import { getSupportedThinkingLevels } from '@earendil-works/pi-ai'
import { isModelType } from '@earendil-works/pi-ai/models'
import type { ModelRuntime } from '@earendil-works/pi-coding-agent'
import type { ModelDescriptor } from '../shared/channel-host.ts'
import type { ModelsResponse } from '../shared/protocol.ts'

async function availableChatModels(runtime: ModelRuntime) {
  const available = new Set(
    (await runtime.getAvailable()).map((model) => `${model.provider}/${model.id}`),
  )
  return runtime
    .getAllModels()
    .filter((model) => isModelType(model, 'chat'))
    .map((model) => ({
      model,
      available: available.has(`${model.provider}/${model.id}`),
    }))
}

export async function listModels(runtime: ModelRuntime): Promise<ModelsResponse> {
  const chatModels = await availableChatModels(runtime)
  return {
    providers: runtime.getProviders().map((provider) => ({
      id: provider.id,
      name: provider.auth.oauth?.name ?? provider.auth.apiKey?.name ?? provider.id,
      authTypes: [
        ...(provider.auth.apiKey?.login
          ? [{ type: 'api_key' as const, name: provider.auth.apiKey.name }]
          : []),
        ...(provider.auth.oauth?.login
          ? [{ type: 'oauth' as const, name: provider.auth.oauth.name }]
          : []),
      ],
      status: runtime.getProviderAuthStatus(provider.id),
      isUsingSubscription: runtime.isUsingSubscription(provider.id),
    })),
    models: chatModels.map(({ model, available }) => ({
      provider: model.provider,
      id: model.id,
      name: model.name,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      reasoning: model.reasoning,
      thinkingLevels: getSupportedThinkingLevels(model),
      cost: model.cost,
      available,
    })),
  }
}

export async function listChannelModels(runtime: ModelRuntime): Promise<ModelDescriptor[]> {
  const chatModels = await availableChatModels(runtime)
  return chatModels.map(({ model, available }) => ({
    provider: model.provider,
    id: model.id,
    name: model.name,
    available,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    thinkingLevels: getSupportedThinkingLevels(model),
    cost: {
      input: model.cost.input,
      output: model.cost.output,
      cacheRead: model.cost.cacheRead,
      cacheWrite: model.cost.cacheWrite,
      ...(model.cost.tiers && {
        tiers: model.cost.tiers.map((tier) => ({
          input: tier.input,
          output: tier.output,
          cacheRead: tier.cacheRead,
          cacheWrite: tier.cacheWrite,
          inputTokensAbove: tier.inputTokensAbove,
        })),
      }),
    },
  }))
}

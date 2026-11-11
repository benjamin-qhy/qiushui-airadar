import { builtinModels } from '@earendil-works/pi-ai/providers/all'
import { createProvider, type Api, type Model } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'

export interface OllamaProviderConfig {
  baseUrl: string
  modelId: string
  modelName: string
}

function ollamaProvider(config?: OllamaProviderConfig) {
  const baseUrl = config ? `${config.baseUrl.replace(/\/+$/u, '')}/v1` : ''
  const models: Model<'openai-completions'>[] = config
    ? [
        {
          id: config.modelId,
          name: config.modelName,
          api: 'openai-completions',
          baseUrl,
          provider: 'ollama',
          reasoning: false,
          input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 131_072,
          maxTokens: 32_768,
          compat: {
            supportsStore: false,
            supportsDeveloperRole: false,
            maxTokensField: 'max_tokens',
          },
        },
      ]
    : []
  return createProvider({
    id: 'ollama',
    name: 'Ollama',
    ...(baseUrl ? { baseUrl } : {}),
    auth: {
      apiKey: {
        name: '无需密钥',
        async check({ signal }) {
          signal.throwIfAborted()
          return { type: 'api_key', source: 'Ollama 局域网服务' }
        },
        async resolve({ signal }) {
          signal.throwIfAborted()
          // Pi's OpenAI-compatible transport requires a non-empty key. Ollama
          // ignores this local placeholder and performs no authentication.
          return {
            auth: { apiKey: 'ollama-local' },
            source: 'Ollama 局域网服务',
          }
        },
      },
    },
    models,
    api: openAICompletionsApi(),
  })
}

// Preserve saved model routes removed from pi's catalog during the 0.85.1 → 1.4.0 upgrade.
// Keep their original IDs and request metadata; never silently substitute a model.
const legacyModels: Model<Api>[] = [
  {
    id: 'deepseek-v4-flash',
    name: 'DeepSeek V4 Flash',
    api: 'openai-completions',
    baseUrl: 'https://api.deepseek.com',
    provider: 'deepseek',
    reasoning: true,
    input: ['text'],
    cost: {
      input: 0.14,
      output: 0.28,
      cacheRead: 0.0028,
      cacheWrite: 0,
    },
    contextWindow: 1000000,
    maxTokens: 384000,
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      maxTokensField: 'max_tokens',
      requiresReasoningContentOnAssistantMessages: true,
      thinkingFormat: 'deepseek',
    },
    thinkingLevelMap: {
      minimal: null,
      low: 'low',
      medium: null,
      high: 'high',
      max: 'max',
    },
  },
  {
    id: 'deepseek-v4-flash-vision-exp',
    name: 'DeepSeek V4 Flash Vision Exp',
    api: 'openai-completions',
    baseUrl: 'https://api.deepseek.com',
    provider: 'deepseek',
    reasoning: true,
    input: ['text', 'image'],
    cost: {
      input: 0.14,
      output: 0.28,
      cacheRead: 0.0028,
      cacheWrite: 0,
    },
    contextWindow: 1000000,
    maxTokens: 384000,
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      maxTokensField: 'max_tokens',
      requiresReasoningContentOnAssistantMessages: true,
      thinkingFormat: 'deepseek',
    },
    thinkingLevelMap: {
      minimal: null,
      low: 'low',
      medium: null,
      high: 'high',
      max: 'max',
    },
  },
  {
    id: 'gpt-5.3-codex-spark',
    name: 'GPT-5.3 Codex Spark',
    api: 'openai-codex-responses',
    provider: 'openai-codex',
    baseUrl: 'https://chatgpt.com/backend-api',
    reasoning: true,
    input: ['text'],
    cost: {
      input: 1.75,
      output: 14,
      cacheRead: 0.175,
      cacheWrite: 0,
    },
    contextWindow: 128000,
    maxTokens: 128000,
    thinkingLevelMap: {
      xhigh: 'xhigh',
      minimal: 'low',
    },
    compat: {
      supportsOpenAIGrammarTools: true,
    },
  },
  {
    id: 'gpt-5.4',
    name: 'GPT-5.4',
    api: 'openai-codex-responses',
    provider: 'openai-codex',
    baseUrl: 'https://chatgpt.com/backend-api',
    reasoning: true,
    input: ['text', 'image'],
    cost: {
      input: 2.5,
      output: 15,
      cacheRead: 0.25,
      cacheWrite: 0,
      tiers: [
        {
          inputTokensAbove: 272000,
          input: 5,
          output: 22.5,
          cacheRead: 0.5,
          cacheWrite: 0,
        },
      ],
    },
    contextWindow: 272000,
    maxTokens: 128000,
    thinkingLevelMap: {
      xhigh: 'xhigh',
      minimal: 'low',
    },
    compat: {
      supportsOpenAIGrammarTools: true,
      supportsToolSearch: true,
    },
  },
  {
    id: 'gpt-5.4-mini',
    name: 'GPT-5.4 mini',
    api: 'openai-codex-responses',
    provider: 'openai-codex',
    baseUrl: 'https://chatgpt.com/backend-api',
    reasoning: true,
    input: ['text', 'image'],
    cost: {
      input: 0.75,
      output: 4.5,
      cacheRead: 0.075,
      cacheWrite: 0,
    },
    contextWindow: 272000,
    maxTokens: 128000,
    thinkingLevelMap: {
      xhigh: 'xhigh',
      minimal: 'low',
    },
    compat: {
      supportsOpenAIGrammarTools: true,
      supportsToolSearch: true,
    },
  },
  {
    id: 'gpt-5.5',
    name: 'GPT-5.5',
    api: 'openai-codex-responses',
    provider: 'openai-codex',
    baseUrl: 'https://chatgpt.com/backend-api',
    reasoning: true,
    input: ['text', 'image'],
    cost: {
      input: 5,
      output: 30,
      cacheRead: 0.5,
      cacheWrite: 0,
      tiers: [
        {
          inputTokensAbove: 272000,
          input: 10,
          output: 45,
          cacheRead: 1,
          cacheWrite: 0,
        },
      ],
    },
    contextWindow: 272000,
    maxTokens: 128000,
    thinkingLevelMap: {
      xhigh: 'xhigh',
      minimal: 'low',
    },
    compat: {
      supportsOpenAIGrammarTools: true,
      supportsToolSearch: true,
    },
  },
]

export function createApplicationModels(
  options?: Parameters<typeof builtinModels>[0] & {
    ollama?: OllamaProviderConfig
  }
) {
  const { ollama, ...modelOptions } = options ?? {}
  const models = builtinModels(modelOptions)
  models.setProvider(ollamaProvider(ollama))
  for (const providerId of new Set(
    legacyModels.map((model) => model.provider)
  )) {
    const provider = models.getProvider(providerId)
    if (!provider) continue
    const additions = legacyModels.filter(
      (model) =>
        model.provider === providerId && !models.getModel(providerId, model.id)
    )
    models.setProvider({
      ...provider,
      getModels: () => [...provider.getModels(), ...additions],
      getAllModels: () => [
        ...(provider.getAllModels?.() ?? provider.getModels()),
        ...additions,
      ],
    })
  }
  return models
}

import { useCallback, useEffect, useMemo, useState } from 'react'
import { CheckCircle2, CircleAlert, Save, Search } from 'lucide-react'
import { ProviderLogin } from './provider-login'
import { PageHeader } from '@/components/page-header'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { api, post, put, remove } from '@/lib/api'

type ModelStage = 'classify' | 'score' | 'translate'

interface ModelConfigData {
  provider: string
  defaultModel: string
  stages: Partial<
    Record<ModelStage, string | { provider: string; model: string }>
  >
  availableModels: Array<{ id: string; name: string }>
  availableModelGroups: ModelGroup[]
}

interface ModelGroup {
  providerId: string
  providerName: string
  models: Array<{ id: string; name: string }>
}

interface ModelProviderItem {
  id: string
  name: string
  authMethods: Array<'api_key' | 'oauth'>
  apiKeyLabel?: string
  oauthLabel?: string
  subscription: boolean
  modelCount: number
  active: boolean
  configured: boolean
  verified?: boolean
  pending?: boolean
  credentialType?: 'api_key' | 'oauth'
  authPath?: string
  usesDefaultPath?: boolean
}

const modelStages: Array<{
  id: ModelStage
  label: string
  description: string
}> = [
  {
    id: 'classify',
    label: '内容判定与摘要',
    description: '判断垃圾内容、生成关键词和摘要',
  },
  { id: 'score', label: '价值评分', description: '按兴趣和内容价值进行评分' },
  {
    id: 'translate',
    label: '英文翻译',
    description: '将符合条件的英文内容翻译为中文',
  },
]

function authDescription(provider: ModelProviderItem) {
  return [
    provider.authMethods.includes('api_key')
      ? (provider.apiKeyLabel ?? 'API Key')
      : '',
    provider.authMethods.includes('oauth')
      ? (provider.oauthLabel ?? '订阅登录')
      : '',
  ]
    .filter(Boolean)
    .join(' / ')
}

function modelChoice(providerId: string, modelId: string) {
  return `${providerId}\n${modelId}`
}

function parseModelChoice(value: string) {
  const [provider, model] = value.split('\n')
  return provider && model ? { provider, model } : undefined
}

export function ModelManagementPage() {
  const [providers, setProviders] = useState<ModelProviderItem[]>([])
  const [selectedProviderId, setSelectedProviderId] = useState('openai-codex')
  const [search, setSearch] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [environment, setEnvironment] = useState('')
  const [modelData, setModelData] = useState<ModelConfigData>()
  const [modelProvider, setModelProvider] = useState('openai-codex')
  const [defaultModel, setDefaultModel] = useState('')
  const [stageModels, setStageModels] = useState<
    Partial<Record<ModelStage, string>>
  >({})
  const [testingProviderId, setTestingProviderId] = useState('')
  const [message, setMessage] = useState('')

  const loadProviders = useCallback(async () => {
    const result = await api<{ items: ModelProviderItem[] }>(
      '/api/model-providers'
    )
    setProviders(result.items)
    setSelectedProviderId((current) =>
      result.items.some((provider) => provider.id === current)
        ? current
        : (result.items[0]?.id ?? '')
    )
    return result.items
  }, [])

  const applyModelData = useCallback(
    (result: ModelConfigData, reset = false) => {
      setModelData(result)
      const configuredGroup = result.availableModelGroups.find(
        (group) => group.providerId === result.provider
      )
      const fallbackGroup = result.availableModelGroups[0]
      const selectedGroup = configuredGroup ?? fallbackGroup
      const available = new Set(
        selectedGroup?.models.map((model) => model.id) ?? []
      )
      setModelProvider(selectedGroup?.providerId ?? '')
      setDefaultModel(
        !reset && available.has(result.defaultModel)
          ? result.defaultModel
          : (selectedGroup?.models[0]?.id ?? '')
      )
      setStageModels(
        reset || selectedGroup?.providerId !== result.provider
          ? {}
          : Object.fromEntries(
              Object.entries(result.stages).map(([stage, route]) => [
                stage,
                typeof route === 'string'
                  ? modelChoice(result.provider, route)
                  : modelChoice(route.provider, route.model),
              ])
            )
      )
    },
    []
  )

  const loadModels = useCallback(
    async (provider?: string, reset = false) => {
      const result = await api<ModelConfigData>(
        `/api/models${provider ? `?provider=${encodeURIComponent(provider)}` : ''}`
      )
      applyModelData(result, reset)
    },
    [applyModelData]
  )

  useEffect(() => {
    void Promise.all([
      api<{ items: ModelProviderItem[] }>('/api/model-providers'),
      api<ModelConfigData>('/api/models'),
    ])
      .then(([providerResult, modelResult]) => {
        setProviders(providerResult.items)
        setSelectedProviderId(
          providerResult.items.some(
            (provider) => provider.id === 'openai-codex'
          )
            ? 'openai-codex'
            : (providerResult.items[0]?.id ?? '')
        )
        applyModelData(modelResult)
      })
      .catch((error) => setMessage(String(error)))
  }, [applyModelData])

  const selectedProvider = providers.find(
    (provider) => provider.id === selectedProviderId
  )
  const visibleProviders = useMemo(() => {
    const term = search.trim().toLocaleLowerCase()
    if (!term) return providers
    return providers.filter((provider) =>
      `${provider.name} ${provider.id}`.toLocaleLowerCase().includes(term)
    )
  }, [providers, search])

  async function saveApiKey(provider: ModelProviderItem) {
    try {
      let env: Record<string, string> | undefined
      if (environment.trim()) {
        const parsed = JSON.parse(environment) as unknown
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
          throw new Error('附加配置必须是 JSON 对象。')
        env = parsed as Record<string, string>
      }
      await put(`/api/model-providers/${encodeURIComponent(provider.id)}`, {
        apiKey,
        env,
      })
      setMessage(
        `${provider.name} 新凭据已暂存。请点击“测试连通性”，成功后才会启用。`
      )
      setApiKey('')
      await Promise.all([loadProviders(), loadModels()])
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    }
  }

  async function testProvider(provider: ModelProviderItem) {
    setTestingProviderId(provider.id)
    try {
      const result = await post<{ message: string }>(
        `/api/model-providers/${encodeURIComponent(provider.id)}/test`,
        {}
      )
      setMessage(result.message)
      await Promise.all([loadProviders(), loadModels()])
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setTestingProviderId('')
    }
  }

  async function clearProvider(provider: ModelProviderItem) {
    try {
      await remove(`/api/model-providers/${encodeURIComponent(provider.id)}`)
      setMessage(`${provider.name} 凭据已移除。`)
      await Promise.all([loadProviders(), loadModels()])
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    }
  }

  async function saveModels() {
    try {
      await put('/api/models', {
        provider: modelProvider,
        defaultModel,
        stages: Object.fromEntries(
          Object.entries(stageModels).flatMap(([stage, choice]) => {
            const route = choice ? parseModelChoice(choice) : undefined
            return route ? [[stage, route]] : []
          })
        ),
      })
      setMessage('模型配置已保存，新采集和手动重试会立即使用。')
      await Promise.all([loadProviders(), loadModels()])
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    }
  }

  function selectDefaultModel(value: string) {
    const route = parseModelChoice(value)
    if (!route) return
    setModelProvider(route.provider)
    setDefaultModel(route.model)
  }

  return (
    <div className='flex h-full min-h-0 flex-col'>
      <PageHeader
        title='模型管理'
        description='统一管理大模型提供商、默认模型和各处理环节使用的模型'
      />
      <div className='min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 pb-24 md:p-6 lg:pb-6'>
        <div className='mx-auto max-w-6xl'>
          {message && (
            <p className='mb-4 border-l-2 border-foreground/30 bg-foreground/[0.025] p-3 text-sm'>
              {message}
            </p>
          )}
          <Tabs defaultValue='providers'>
            <TabsList>
              <TabsTrigger value='providers'>提供商管理</TabsTrigger>
              <TabsTrigger value='models'>模型配置</TabsTrigger>
            </TabsList>
            <TabsContent value='providers' className='mt-5'>
              <div className='grid min-h-[34rem] gap-6 md:grid-cols-[18rem_minmax(0,1fr)]'>
                <aside>
                  <div className='relative mb-3'>
                    <Search className='absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground' />
                    <Input
                      aria-label='搜索大模型提供商'
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                      placeholder='搜索提供商'
                      className='pl-9'
                    />
                  </div>
                  <div className='max-h-[38rem] overflow-y-auto'>
                    {visibleProviders.map((provider) => (
                      <button
                        key={provider.id}
                        type='button'
                        onClick={() => {
                          setSelectedProviderId(provider.id)
                          setApiKey('')
                          setEnvironment('')
                        }}
                        className={`flex w-full items-start justify-between gap-3 rounded-md px-3 py-2.5 text-left hover:bg-foreground/[0.025] ${selectedProviderId === provider.id ? 'bg-foreground/[0.05]' : ''}`}
                      >
                        <span className='min-w-0'>
                          <span className='block truncate text-sm font-medium'>
                            {provider.name}
                          </span>
                          <span className='block truncate font-mono text-[11px] text-muted-foreground'>
                            {provider.id}
                          </span>
                        </span>
                        <span
                          className={`mt-1 size-2 shrink-0 rounded-full ${provider.configured ? 'bg-blue-500' : 'bg-foreground/20'}`}
                        />
                      </button>
                    ))}
                  </div>
                </aside>
                {selectedProvider && (
                  <section className='border-t pt-4 md:border-l md:border-t-0 md:pl-6 md:pt-0'>
                    <div className='flex flex-wrap items-start justify-between gap-3'>
                      <div>
                        <div className='flex items-center gap-2'>
                          <h2 className='font-display text-2xl font-semibold'>
                            {selectedProvider.name}
                          </h2>
                          {selectedProvider.active && (
                            <Badge variant='outline'>当前使用</Badge>
                          )}
                        </div>
                        <p className='mt-1 font-mono text-xs text-muted-foreground'>
                          {selectedProvider.id} · {selectedProvider.modelCount}{' '}
                          个模型
                        </p>
                      </div>
                      <div className='flex items-center gap-2 text-sm'>
                        {selectedProvider.verified &&
                        !selectedProvider.pending ? (
                          <CheckCircle2 className='size-4 text-blue-500' />
                        ) : (
                          <CircleAlert className='size-4 text-muted-foreground' />
                        )}
                        {selectedProvider.pending
                          ? '新凭据待验证'
                          : selectedProvider.verified
                            ? '已通过连接测试'
                            : selectedProvider.configured
                              ? '凭据已保存，待测试'
                              : '未配置'}
                      </div>
                    </div>
                    <div className='mt-5 bg-foreground/[0.025] p-4'>
                      <div className='font-mono text-xs text-muted-foreground'>
                        支持的认证方式
                      </div>
                      <p className='mt-1 text-sm'>
                        {authDescription(selectedProvider)}
                      </p>
                    </div>
                    {selectedProvider.authMethods.includes('oauth') && (
                      <ProviderLogin
                        key={selectedProvider.id}
                        providerId={selectedProvider.id}
                        configured={selectedProvider.configured}
                        onComplete={async () => {
                          await loadProviders()
                          await loadModels()
                        }}
                      />
                    )}
                    {selectedProvider.authMethods.includes('api_key') && (
                      <div className='mt-6 grid gap-4'>
                        <div>
                          <h3 className='font-display text-lg font-semibold'>
                            配置 API 凭据
                          </h3>
                          <p className='mt-1 text-sm text-muted-foreground'>
                            保存后需测试连通性，测试通过才启用新凭据；密钥不会回显。
                          </p>
                        </div>
                        <label className='grid gap-1.5 text-sm'>
                          <span className='font-medium'>
                            {selectedProvider.apiKeyLabel ?? 'API Key'}
                          </span>
                          <Input
                            type='password'
                            autoComplete='off'
                            value={apiKey}
                            onChange={(event) => setApiKey(event.target.value)}
                            placeholder={
                              selectedProvider.configured
                                ? '已配置，输入新值可替换'
                                : '输入 API Key'
                            }
                          />
                        </label>
                        <label className='grid gap-1.5 text-sm'>
                          <span className='font-medium'>附加配置（可选）</span>
                          <span className='text-xs text-muted-foreground'>
                            Azure、Cloudflare 等提供商可填写 JSON，例如账户
                            ID、网关 ID。
                          </span>
                          <textarea
                            aria-label='附加配置'
                            value={environment}
                            onChange={(event) =>
                              setEnvironment(event.target.value)
                            }
                            placeholder={'{"CLOUDFLARE_ACCOUNT_ID":"..."}'}
                            className='min-h-24 rounded-md border bg-background px-3 py-2 font-mono text-sm'
                          />
                        </label>
                        <Button
                          className='w-fit'
                          size='sm'
                          disabled={!apiKey.trim()}
                          onClick={() => void saveApiKey(selectedProvider)}
                        >
                          <Save />
                          保存凭据
                        </Button>
                      </div>
                    )}
                    <div className='mt-7 flex flex-wrap gap-2 border-t pt-4'>
                      {(selectedProvider.configured ||
                        selectedProvider.pending) && (
                        <>
                          <Button
                            variant='outline'
                            size='sm'
                            disabled={testingProviderId === selectedProvider.id}
                            onClick={() => void testProvider(selectedProvider)}
                          >
                            {testingProviderId === selectedProvider.id
                              ? '正在测试…'
                              : '测试连通性'}
                          </Button>
                          <Button
                            variant='ghost'
                            size='sm'
                            onClick={() => void clearProvider(selectedProvider)}
                          >
                            移除凭据
                          </Button>
                        </>
                      )}
                    </div>
                  </section>
                )}
              </div>
            </TabsContent>
            <TabsContent value='models' className='mt-5'>
              <section className='border-t pt-4'>
                <div className='flex flex-wrap items-start justify-between gap-3'>
                  <div>
                    <h2 className='font-display text-xl font-semibold'>
                      模型配置
                    </h2>
                    <p className='mt-1 text-sm text-muted-foreground'>
                      从已配置提供商的模型中直接选择，并按处理环节单独覆盖。
                    </p>
                  </div>
                  <Button
                    size='sm'
                    disabled={!modelData || !defaultModel}
                    onClick={() => void saveModels()}
                  >
                    <Save />
                    保存模型配置
                  </Button>
                </div>
                {modelData && (
                  <div className='mt-5 grid gap-5'>
                    {modelData.availableModelGroups.length === 0 ? (
                      <div className='bg-foreground/[0.025] p-4 text-sm'>
                        <p className='font-medium'>还没有可选择的模型</p>
                        <p className='mt-1 text-muted-foreground'>
                          请先到“提供商管理”完成至少一个提供商的配置。
                        </p>
                      </div>
                    ) : (
                      <>
                        <label className='grid gap-1.5 text-sm sm:grid-cols-[minmax(0,1fr)_minmax(16rem,22rem)] sm:items-center'>
                          <span>
                            <span className='font-medium'>默认模型</span>
                            <span className='mt-0.5 block text-xs text-muted-foreground'>
                              只显示已配置的提供商，并按提供商分组
                            </span>
                          </span>
                          <select
                            aria-label='默认模型'
                            value={modelChoice(modelProvider, defaultModel)}
                            onChange={(event) =>
                              selectDefaultModel(event.target.value)
                            }
                            className='h-9 w-full rounded-md border bg-background px-3 font-mono text-sm'
                          >
                            {modelData.availableModelGroups.map((group) => (
                              <optgroup
                                key={group.providerId}
                                label={group.providerName}
                              >
                                {group.models.map((model) => (
                                  <option
                                    key={`${group.providerId}/${model.id}`}
                                    value={modelChoice(
                                      group.providerId,
                                      model.id
                                    )}
                                  >
                                    {model.name} ({model.id})
                                  </option>
                                ))}
                              </optgroup>
                            ))}
                          </select>
                        </label>
                        <div className='border-t pt-4'>
                          <div className='mb-3 font-mono text-xs text-muted-foreground'>
                            按处理环节单独设置
                          </div>
                          <div className='grid gap-4'>
                            {modelStages.map((stage) => (
                              <label
                                key={stage.id}
                                className='grid gap-1.5 text-sm sm:grid-cols-[minmax(0,1fr)_minmax(16rem,22rem)] sm:items-center'
                              >
                                <span>
                                  <span className='font-medium'>
                                    {stage.label}
                                  </span>
                                  <span className='mt-0.5 block text-xs text-muted-foreground'>
                                    {stage.description}
                                  </span>
                                </span>
                                <select
                                  aria-label={`${stage.label}模型`}
                                  value={stageModels[stage.id] ?? ''}
                                  onChange={(event) =>
                                    setStageModels((current) => ({
                                      ...current,
                                      [stage.id]:
                                        event.target.value || undefined,
                                    }))
                                  }
                                  className='h-9 w-full rounded-md border bg-background px-3 font-mono text-sm'
                                >
                                  <option value=''>
                                    跟随默认模型（{defaultModel}）
                                  </option>
                                  {modelData.availableModelGroups.map(
                                    (group) => (
                                      <optgroup
                                        key={group.providerId}
                                        label={group.providerName}
                                      >
                                        {group.models.map((model) => (
                                          <option
                                            key={`${group.providerId}/${model.id}`}
                                            value={modelChoice(
                                              group.providerId,
                                              model.id
                                            )}
                                          >
                                            {model.name} ({model.id})
                                          </option>
                                        ))}
                                      </optgroup>
                                    )
                                  )}
                                </select>
                              </label>
                            ))}
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </section>
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </div>
  )
}

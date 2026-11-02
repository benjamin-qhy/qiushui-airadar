import { randomUUID } from 'node:crypto'
import { createApplicationModels } from './pi-models.js'
import type {
  AuthEvent,
  AuthPrompt,
  CredentialStore,
  Model,
  Models,
} from '@earendil-works/pi-ai'

export function createProviderLoginManager(
  credentials: CredentialStore,
  injected?: Models,
  timeoutMs = 600_000
) {
  const models = injected ?? createApplicationModels({ credentials })
  type Session = {
    id: string
    providerId: string
    status: 'pending' | 'completed' | 'cancelled' | 'expired' | 'failed'
    events: AuthEvent[]
    prompt?: Omit<AuthPrompt, 'signal'> & { id: string }
    controller: AbortController
    timer: ReturnType<typeof setTimeout>
    answer?: (answer: string) => void
  }
  const sessions = new Map<string, Session>()
  const snapshot = (s: Session) => ({
    id: s.id,
    providerId: s.providerId,
    status: s.status,
    events: s.events,
    prompt: s.prompt,
  })
  function cancel(id: string, status: 'cancelled' | 'expired' = 'cancelled') {
    const s = sessions.get(id)
    if (!s) throw new Error('登录会话不存在，请重新开始。')
    if (s.status === 'pending') {
      s.status = status
      s.controller.abort()
      s.prompt = undefined
      s.answer = undefined
      clearTimeout(s.timer)
    }
    return snapshot(s)
  }
  return {
    models,
    start(
      providerId: string,
      codexMethod: 'browser' | 'device_code' = 'browser'
    ) {
      if (!models.getProviders().find((p) => p.id === providerId)?.auth.oauth)
        throw new Error('该提供商不支持账号登录。')
      for (const session of sessions.values())
        if (session.status === 'pending') cancel(session.id)
      // Completed sessions contain temporary authorization URLs; keep no history.
      sessions.clear()
      const id = randomUUID()
      const s: Session = {
        id,
        providerId,
        status: 'pending',
        events: [],
        controller: new AbortController(),
        timer: setTimeout(() => cancel(id, 'expired'), timeoutMs),
      }
      s.timer.unref()
      sessions.set(id, s)
      void models
        .login(providerId, 'oauth', {
          signal: s.controller.signal,
          notify(event) {
            if (s.status === 'pending')
              s.events = [...s.events.slice(-19), event]
          },
          prompt(prompt) {
            if (
              providerId === 'openai-codex' &&
              prompt.type === 'select' &&
              prompt.options.some((option) => option.id === codexMethod)
            )
              return Promise.resolve(codexMethod)
            return new Promise<string>((resolve, reject) => {
              const { signal, ...visible } = prompt
              const promptId = randomUUID()
              const cleanup = () => {
                signal?.removeEventListener('abort', abort)
                s.controller.signal.removeEventListener('abort', abort)
                if (s.prompt?.id === promptId) {
                  s.prompt = undefined
                  s.answer = undefined
                }
              }
              const abort = () => {
                cleanup()
                reject(new Error('Login cancelled'))
              }
              s.prompt = { ...visible, id: promptId }
              s.answer = (answer) => {
                cleanup()
                resolve(answer)
              }
              signal?.addEventListener('abort', abort, { once: true })
              s.controller.signal.addEventListener('abort', abort, {
                once: true,
              })
              if (signal?.aborted || s.controller.signal.aborted) abort()
            })
          },
        })
        .then(() => {
          if (s.status === 'pending') s.status = 'completed'
        })
        .catch(() => {
          if (s.status === 'pending') s.status = 'failed'
        })
        .finally(() => {
          clearTimeout(s.timer)
          s.prompt = undefined
          s.answer = undefined
          s.events = []
        })
      return snapshot(s)
    },
    get(id: string) {
      const s = sessions.get(id)
      if (!s) throw new Error('登录会话已结束，请重新开始。')
      return snapshot(s)
    },
    respond(id: string, promptId: string, answer: string) {
      const s = sessions.get(id)
      if (
        !s ||
        s.status !== 'pending' ||
        s.prompt?.id !== promptId ||
        !s.answer
      )
        throw new Error('此步骤已结束，请等待页面更新。')
      if (
        s.prompt.type === 'select' &&
        !(
          'options' in s.prompt &&
          (s.prompt.options as Array<{ id: string }>).some(
            (o) => o.id === answer
          )
        )
      )
        throw new Error('请选择有效的登录方式。')
      s.answer(answer)
      return snapshot(s)
    },
    cancel,
    stop() {
      for (const s of sessions.values()) cancel(s.id)
      sessions.clear()
    },
    async test(providerId: string, modelId: string) {
      const model = models.getModel(providerId, modelId)
      if (!model || !(await models.checkAuth(providerId)))
        throw new Error('请先登录并选择可用模型。')
      const context = {
        messages: [
          {
            role: 'user' as const,
            content: 'Reply with OK.',
            timestamp: Date.now(),
          },
        ],
      }
      const options = {
        maxTokens: 256,
        maxRetries: 0,
        signal: AbortSignal.timeout(45_000),
      }
      const response =
        model.api === 'openai-codex-responses'
          ? await models.complete(
              model as Model<'openai-codex-responses'>,
              context,
              {
                ...options,
                reasoningEffort: 'none',
              }
            )
          : await models.completeSimple(model, context, options)
      if (
        response.stopReason === 'error' ||
        response.stopReason === 'aborted' ||
        !response.content.some((b) => b.type === 'text' && b.text.trim())
      )
        throw new Error('连接测试未成功，请检查账号权限、额度或网络后重试。')
      return { status: 'succeeded', message: '模型已成功响应，可以使用。' }
    },
  }
}

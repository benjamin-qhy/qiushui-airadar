import http, { request } from 'node:http'
import { expect, it } from 'vitest'
import { pinnedArticleRequestOptions } from './article-http.js'

it('constructs pinned HTTP article requests with environment proxy enabled without a Host/authority error', () => {
  const previous = http.globalAgent
  http.globalAgent = new http.Agent(
    Object.assign(
      { keepAlive: false },
      { proxyEnv: { HTTP_PROXY: 'http://127.0.0.1:9' } }
    )
  )
  try {
    const options = pinnedArticleRequestOptions(
      new URL('http://github.com/apekshik/anyshot'),
      { address: '20.205.243.166', family: 4 },
      'test'
    )
    expect(options.hostname).toBe('20.205.243.166')
    expect(options.headers).toMatchObject({ host: 'github.com' })
    expect(() => {
      const outgoing = request(options)
      outgoing.on('error', () => {})
      outgoing.destroy()
    }).not.toThrow()
  } finally {
    http.globalAgent.destroy()
    http.globalAgent = previous
  }
})

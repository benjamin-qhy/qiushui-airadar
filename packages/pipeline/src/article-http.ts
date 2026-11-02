import type { RequestOptions } from 'node:https'

// The network destination remains the public address validated by the caller.
export function pinnedArticleRequestOptions(
  url: URL,
  address: { address: string; family: number },
  userAgent: string
): RequestOptions {
  return {
    hostname: address.address,
    family: address.family,
    port: url.port || undefined,
    path: `${url.pathname}${url.search}`,
    method: 'GET',
    signal: AbortSignal.timeout(30_000),
    // Forward HTTP proxies require authority=Host, which conflicts with a
    // validated IP plus the virtual-host header. Connect directly to that IP;
    // HTTPS continues using its existing proxy/TLS path.
    ...(url.protocol === 'http:' ? { agent: false as const } : {}),
    servername: url.hostname,
    headers: {
      host: url.host,
      accept: 'text/html,application/xhtml+xml',
      'user-agent': userAgent,
    },
  }
}

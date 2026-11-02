import { useSyncExternalStore, type MouseEvent } from 'react'
import type { PageKey } from '@/types'
import type { ContentScope } from './content-filters'

export const pages: readonly PageKey[] = [
  'daily',
  'all',
  'unprocessed',
  'exceptions',
  'favorites',
  'junk',
  'sources',
  'collection-settings',
  'models',
  'runtime',
  'runtime-log',
  'config',
]
const contentScopes: readonly ContentScope[] = [
  'daily',
  'all',
  'unprocessed',
  'exceptions',
  'favorites',
  'junk',
]
const locationEvent = 'airadar:navigate'

function snapshot() {
  return typeof window === 'undefined'
    ? '/'
    : `${window.location.pathname ?? '/'}${window.location.search ?? ''}${window.location.hash ?? ''}`
}
function subscribe(listener: () => void) {
  window.addEventListener('popstate', listener)
  window.addEventListener(locationEvent, listener)
  return () => {
    window.removeEventListener('popstate', listener)
    window.removeEventListener(locationEvent, listener)
  }
}
export function useBrowserUrl() {
  return new URL(
    useSyncExternalStore(subscribe, snapshot, snapshot),
    'http://airadar.local'
  )
}
export function navigate(url: string | URL, replace = false) {
  const target = new URL(String(url), window.location.href)
  if (target.href === window.location.href) return
  window.history[replace ? 'replaceState' : 'pushState'](
    window.history.state,
    '',
    target
  )
  window.dispatchEvent(new Event(locationEvent))
}
export function followLink(
  event: MouseEvent<HTMLAnchorElement>,
  action: () => void
) {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  )
    return
  event.preventDefault()
  action()
}
export function pageHref(page: PageKey) {
  return `/${page}`
}
export function readRoute(url: URL): { page: PageKey; contentId?: string } {
  const detail = /^\/content\/([^/]+)\/?$/.exec(url.pathname)
  if (detail) {
    try {
      return {
        page:
          contentScopes.find(
            (scope) => scope === url.searchParams.get('from')
          ) ?? 'all',
        contentId: decodeURIComponent(detail[1]),
      }
    } catch {
      return { page: 'all' }
    }
  }
  const path = url.pathname.replace(/^\/|\/$/g, '')
  return {
    page:
      pages.find((page) => page === path) ??
      pages.find((page) => page === url.searchParams.get('page')) ??
      'daily',
  }
}
export function contentHref(id: string, scope: ContentScope, search = '') {
  const url = new URL(
    `/content/${encodeURIComponent(id)}`,
    'http://airadar.local'
  )
  url.search = search
  url.searchParams.delete('page')
  url.searchParams.set('from', scope)
  return `${url.pathname}${url.search}`
}
export function listHref(scope: ContentScope, search = '') {
  const params = new URLSearchParams(search)
  params.delete('from')
  params.delete('page')
  return `${pageHref(scope)}${params.size ? `?${params}` : ''}`
}

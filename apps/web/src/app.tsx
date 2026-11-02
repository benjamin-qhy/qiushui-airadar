import { useEffect } from 'react'
import { navigate, pageHref, readRoute, useBrowserUrl } from '@/lib/navigation'
import { AppShell } from '@/components/app-shell'
import { ConfigPage } from '@/features/config-page'
import { CollectionSettingsPage } from '@/features/collection-settings-page'
import { ContentWorkspace } from '@/features/content-workspace'
import { ModelManagementPage } from '@/features/model-management-page'
import { RuntimePage } from '@/features/runtime-page'
import { RuntimeLogPage } from '@/features/runtime-log-page'
import { SourcesPage } from '@/features/sources-page'
import type { PageKey } from '@/types'

export { ContentCard } from '@/features/content-workspace'
export type { FeedItem } from '@/types'

export function App() {
  const url = useBrowserUrl()
  const { page } = readRoute(url)
  useEffect(() => {
    const current = new URL(window.location.href)
    if (current.pathname === '/') {
      current.pathname = pageHref(readRoute(current).page)
      current.searchParams.delete('page')
      navigate(current, true)
    }
  }, [])
  const setPage = (next: PageKey) => {
    if (next !== page || readRoute(url).contentId) navigate(pageHref(next))
  }
  return (
    <AppShell page={page} onPage={setPage}>
      {page === 'daily' ? (
        <ContentWorkspace key='daily' scope='daily' />
      ) : page === 'all' ? (
        <ContentWorkspace key='all' scope='all' />
      ) : page === 'unprocessed' ? (
        <ContentWorkspace key='unprocessed' scope='unprocessed' />
      ) : page === 'exceptions' ? (
        <ContentWorkspace key='exceptions' scope='exceptions' />
      ) : page === 'favorites' ? (
        <ContentWorkspace key='favorites' scope='favorites' />
      ) : page === 'junk' ? (
        <ContentWorkspace key='junk' scope='junk' />
      ) : page === 'sources' ? (
        <SourcesPage />
      ) : page === 'collection-settings' ? (
        <CollectionSettingsPage />
      ) : page === 'models' ? (
        <ModelManagementPage />
      ) : page === 'runtime' ? (
        <RuntimePage />
      ) : page === 'runtime-log' ? (
        <RuntimeLogPage />
      ) : (
        <ConfigPage />
      )}
    </AppShell>
  )
}

import { CollectionMediaPolicy } from '@/features/collection-media-policy'
import { PageHeader } from '@/components/page-header'
import { CollectionProvidersPanel } from '@/features/collection-providers-panel'
import { CollectionTranslationPolicy } from '@/features/collection-translation-policy'
import { CollectionConcurrencySettings } from '@/features/collection-concurrency-settings'

export function CollectionSettingsPage() {
  return (
    <div className='flex h-full min-h-0 flex-col'>
      <PageHeader
        title='采集设置'
        description='设置并发数量、自动翻译与平台接口'
      />
      <div className='min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 pb-24 md:p-6 lg:pb-6'>
        <div className='mx-auto max-w-[1500px]'>
          <CollectionConcurrencySettings />
          <CollectionMediaPolicy />
          <CollectionTranslationPolicy />
          <CollectionProvidersPanel />
        </div>
      </div>
    </div>
  )
}

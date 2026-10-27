import type { ReactNode } from 'react'
import {
  BookOpen,
  Bookmark,
  Bot,
  Cable,
  Database,
  ListFilter,
  Radar,
  ScrollText,
  Settings2,
  Sparkles,
  Trash2,
  TriangleAlert,
} from 'lucide-react'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from '@/components/ui/sidebar'
import type { PageKey } from '@/types'

const navigationGroups: Array<{
  label: string
  items: Array<{ id: PageKey; label: string; icon: typeof Radar }>
}> = [
  {
    label: '内容',
    items: [
      { id: 'daily', label: '每日精选', icon: Sparkles },
      { id: 'all', label: '全部内容', icon: ListFilter },
      { id: 'exceptions', label: '异常数据', icon: TriangleAlert },
      { id: 'favorites', label: '我的收藏', icon: Bookmark },
      { id: 'junk', label: '垃圾内容', icon: Trash2 },
    ],
  },
  {
    label: '管理',
    items: [
      { id: 'sources', label: '信源管理', icon: BookOpen },
      { id: 'collection-settings', label: '采集设置', icon: Cable },
      { id: 'models', label: '模型管理', icon: Bot },
    ],
  },
  {
    label: '系统',
    items: [
      { id: 'runtime', label: '运行状态', icon: Database },
      { id: 'runtime-log', label: '运行日志', icon: ScrollText },
      { id: 'config', label: '系统配置', icon: Settings2 },
    ],
  },
]
const navigation = navigationGroups.flatMap((group) => group.items)

export function AppShell({
  page,
  onPage,
  children,
}: {
  page: PageKey
  onPage: (page: PageKey) => void
  children: ReactNode
}) {
  return (
    <SidebarProvider>
      <Sidebar collapsible='offcanvas' className='overscroll-none'>
        <SidebarHeader className='h-16 justify-center border-b px-3 py-0'>
          <div className='flex min-w-0 items-center gap-3'>
            <span className='flex size-9 shrink-0 items-center justify-center rounded-sm bg-primary text-primary-foreground'>
              <Radar className='size-5' />
            </span>
            <div className='min-w-0 group-data-[state=collapsed]/sidebar:hidden'>
              <div className='font-semibold'>qiushui-airadar</div>
              <div className='text-xs text-muted-foreground'>
                个人 AI 情报台
              </div>
            </div>
            <SidebarTrigger className='ml-auto group-data-[state=collapsed]/sidebar:hidden' />
          </div>
        </SidebarHeader>
        <SidebarContent className='py-2'>
          {navigationGroups.map((group) => (
            <SidebarGroup key={group.label}>
              <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {group.items.map(({ id, label, icon: Icon }) => (
                    <SidebarMenuItem key={id}>
                      <SidebarMenuButton
                        aria-label={label}
                        aria-current={page === id ? 'page' : undefined}
                        isActive={page === id}
                        tooltip={label}
                        onClick={() => onPage(id)}
                      >
                        <Icon />
                        <span>{label}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          ))}
        </SidebarContent>
        <SidebarFooter className='border-t text-xs text-muted-foreground group-data-[state=collapsed]/sidebar:hidden'>
          <div className='mb-1 font-medium text-foreground'>真实数据模式</div>
          <div>页面只读取本机服务与持久化数据。</div>
        </SidebarFooter>
      </Sidebar>
      <SidebarInset>
        <main className='min-h-0 min-w-0 flex-1 overflow-hidden'>
          {children}
        </main>
        <nav className='fixed inset-x-0 bottom-0 z-40 grid w-screen max-w-full grid-cols-10 border-t bg-background/95 px-1 py-1 backdrop-blur lg:hidden'>
          {navigation.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              aria-current={page === id ? 'page' : undefined}
              className={`min-w-0 flex flex-col items-center gap-1 rounded-md py-2 text-[10px] ${page === id ? 'bg-foreground/[0.06] text-foreground' : 'text-muted-foreground'}`}
              onClick={() => onPage(id)}
            >
              <Icon className='size-4' />
              <span className='w-full truncate px-0.5'>{label}</span>
            </button>
          ))}
        </nav>
      </SidebarInset>
    </SidebarProvider>
  )
}

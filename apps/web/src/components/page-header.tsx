import type { ReactNode } from 'react'
import { SidebarTrigger, useSidebar } from '@/components/ui/sidebar'
import { Menu } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export function PageHeader({
  title,
  description,
  children,
  className,
}: {
  title: string
  description?: ReactNode
  children?: ReactNode
  className?: string
}) {
  const { state, mobileOpen, toggleSidebar } = useSidebar()

  return (
    <header
      data-slot='page-header'
      className={cn(
        'pt-[max(0.5rem,env(safe-area-inset-top))] z-30 flex min-h-16 shrink-0 flex-wrap items-center gap-3 bg-background/95 px-4 py-2 backdrop-blur',
        className
      )}
    >
      <div className='flex min-w-0 shrink-0 items-center gap-3'>
        <Button
          variant='ghost'
          className='h-11 gap-2 px-2 lg:hidden'
          aria-label='菜单'
          aria-expanded={mobileOpen}
          aria-controls={mobileOpen ? 'mobile-navigation' : undefined}
          aria-haspopup='dialog'
          data-sidebar-mobile-trigger=''
          onClick={toggleSidebar}
        >
          <Menu className='size-5' />
          菜单
        </Button>
        {state === 'collapsed' && (
          <SidebarTrigger className='hidden lg:inline-flex' />
        )}
        <div className='min-w-0'>
          <h1 className='truncate text-base font-semibold'>{title}</h1>
          {description && (
            <div className='text-xs text-muted-foreground'>{description}</div>
          )}
        </div>
      </div>
      {children && (
        <div className='ml-auto flex min-w-0 flex-1 flex-wrap items-center justify-end gap-2'>
          {children}
        </div>
      )}
    </header>
  )
}

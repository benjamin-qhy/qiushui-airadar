import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useMobile } from '@/lib/use-mobile'
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet'

type SidebarContextValue = {
  open: boolean
  state: 'expanded' | 'collapsed'
  toggleSidebar: () => void
  mobileOpen: boolean
  setMobileOpen: (open: boolean) => void
}

const SidebarContext = React.createContext<SidebarContextValue | null>(null)

function useSidebar() {
  const context = React.useContext(SidebarContext)
  if (!context)
    throw new Error('useSidebar must be used within SidebarProvider')
  return context
}

function SidebarProvider({
  defaultOpen = true,
  className,
  children,
  ...props
}: React.ComponentProps<'div'> & { defaultOpen?: boolean }) {
  const [open, setOpen] = React.useState(defaultOpen)
  const [mobileOpen, setMobileOpen] = React.useState(false)
  const mobile = useMobile()
  const toggleSidebar = React.useCallback(() => {
    if (mobile) setMobileOpen((value) => !value)
    else setOpen((value) => !value)
  }, [mobile])

  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === 'b' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        toggleSidebar()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [toggleSidebar])

  const value = React.useMemo<SidebarContextValue>(
    () => ({
      open,
      state: open ? 'expanded' : 'collapsed',
      toggleSidebar,
      mobileOpen,
      setMobileOpen,
    }),
    [open, toggleSidebar, mobileOpen]
  )

  return (
    <SidebarContext.Provider value={value}>
      <TooltipProvider delayDuration={0}>
        <div
          data-slot='sidebar-wrapper'
          className={cn(
            'group/sidebar-wrapper flex h-svh min-h-0 w-full overflow-hidden bg-background',
            className
          )}
          {...props}
        >
          {children}
        </div>
      </TooltipProvider>
    </SidebarContext.Provider>
  )
}

function Sidebar({
  side = 'left',
  collapsible = 'offcanvas',
  className,
  children,
  ...props
}: React.ComponentProps<'aside'> & {
  side?: 'left' | 'right'
  collapsible?: 'offcanvas' | 'none'
}) {
  const context = React.useContext(SidebarContext)
  const mobile = useMobile()
  const collapsed =
    collapsible === 'offcanvas' && context?.state === 'collapsed'

  if (collapsible === 'offcanvas' && mobile && context) {
    return (
      <Sheet open={context.mobileOpen} onOpenChange={context.setMobileOpen}>
        <SheetContent
          side={side}
          data-slot='sidebar'
          id='mobile-navigation'
          closeLabel='关闭菜单'
          className='group/sidebar data-[state=open]:animate-none data-[state=closed]:animate-none w-[min(20rem,85vw)] gap-0 pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)] [&>[data-slot=sidebar-header]_button]:hidden [&>button]:size-11 [&>button]:top-2 [&>button]:end-2 [&>button]:flex [&>button]:items-center [&>button]:justify-center'
          onClickCapture={(event) => {
            if ((event.target as Element).closest('a'))
              context.setMobileOpen(false)
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            document
              .querySelector<HTMLButtonElement>('[data-sidebar-mobile-trigger]')
              ?.focus()
          }}
        >
          <SheetTitle className='sr-only'>导航菜单</SheetTitle>
          <SheetDescription className='sr-only'>
            选择内容、管理或系统页面
          </SheetDescription>
          {children}
        </SheetContent>
      </Sheet>
    )
  }

  return (
    <aside
      data-slot='sidebar'
      data-side={side}
      data-state={collapsed ? 'collapsed' : 'expanded'}
      data-collapsible={collapsed ? collapsible : ''}
      className={cn(
        'group/sidebar relative h-svh min-h-0 shrink-0 flex-col overflow-hidden bg-sidebar text-sidebar-foreground transition-[width] duration-200 ease-linear',
        side === 'left' ? 'border-r' : 'border-l',
        collapsible === 'none'
          ? 'flex w-full'
          : collapsed
            ? 'hidden w-0 border-r-0 lg:flex'
            : 'hidden w-64 lg:flex',
        className
      )}
      {...props}
    >
      {children}
    </aside>
  )
}

function SidebarHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot='sidebar-header'
      className={cn('flex shrink-0 flex-col gap-2 p-3', className)}
      {...props}
    />
  )
}

function SidebarContent({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot='sidebar-content'
      className={cn(
        'min-h-0 flex-1 overflow-y-auto overscroll-contain',
        className
      )}
      {...props}
    />
  )
}

function SidebarFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot='sidebar-footer'
      className={cn('shrink-0 overscroll-none p-3', className)}
      {...props}
    />
  )
}

function SidebarGroup({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot='sidebar-group'
      className={cn('flex min-w-0 flex-col px-2 py-2', className)}
      {...props}
    />
  )
}

function SidebarGroupLabel({
  className,
  ...props
}: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot='sidebar-group-label'
      className={cn(
        'h-7 overflow-hidden px-2 font-mono text-[10px] leading-7 text-muted-foreground transition-[height,opacity] group-data-[state=collapsed]/sidebar:h-0 group-data-[state=collapsed]/sidebar:opacity-0',
        className
      )}
      {...props}
    />
  )
}

function SidebarGroupContent({
  className,
  ...props
}: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot='sidebar-group-content'
      className={cn('w-full text-sm', className)}
      {...props}
    />
  )
}

function SidebarMenu({ className, ...props }: React.ComponentProps<'ul'>) {
  return (
    <ul
      data-slot='sidebar-menu'
      className={cn('flex min-w-0 flex-col gap-1', className)}
      {...props}
    />
  )
}

function SidebarMenuItem({ className, ...props }: React.ComponentProps<'li'>) {
  return (
    <li
      data-slot='sidebar-menu-item'
      className={cn('min-w-0', className)}
      {...props}
    />
  )
}

function SidebarMenuButton({
  asChild = false,
  isActive = false,
  tooltip,
  className,
  children,
  ...props
}: React.ComponentProps<'button'> & {
  asChild?: boolean
  isActive?: boolean
  tooltip?: string
}) {
  const context = React.useContext(SidebarContext)
  const Component = asChild ? Slot : 'button'
  const button = (
    <Component
      data-slot='sidebar-menu-button'
      data-active={isActive}
      className={cn(
        'flex h-11 lg:h-9 w-full min-w-0 items-center gap-3 overflow-hidden rounded-md px-2 text-left text-sm outline-none transition-colors hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring data-[active=true]:bg-sidebar-accent data-[active=true]:font-medium group-data-[state=collapsed]/sidebar:size-9 group-data-[state=collapsed]/sidebar:justify-center group-data-[state=collapsed]/sidebar:p-0 [&>svg]:size-4 [&>svg]:shrink-0 [&>span]:truncate group-data-[state=collapsed]/sidebar:[&>span]:hidden',
        className
      )}
      {...props}
    >
      {children}
    </Component>
  )

  if (!tooltip || context?.state !== 'collapsed') return button
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side='right'>{tooltip}</TooltipContent>
    </Tooltip>
  )
}

function SidebarTrigger({
  className,
  ...props
}: React.ComponentProps<typeof Button>) {
  const { state, toggleSidebar } = useSidebar()
  const label = state === 'collapsed' ? '展开侧栏' : '折叠侧栏'
  return (
    <Button
      data-slot='sidebar-trigger'
      variant='ghost'
      size='icon'
      className={cn('size-8', className)}
      aria-label={label}
      title={label}
      onClick={toggleSidebar}
      {...props}
    >
      {state === 'collapsed' ? <PanelLeftOpen /> : <PanelLeftClose />}
    </Button>
  )
}

function SidebarRail({ className, ...props }: React.ComponentProps<'button'>) {
  const { state, toggleSidebar } = useSidebar()
  const label = state === 'collapsed' ? '展开侧栏' : '折叠侧栏'
  return (
    <button
      data-slot='sidebar-rail'
      aria-label={label}
      title={label}
      tabIndex={-1}
      onClick={toggleSidebar}
      className={cn(
        'absolute inset-y-0 right-0 z-20 hidden w-2 translate-x-1/2 cursor-w-resize after:absolute after:inset-y-0 after:left-1/2 after:w-px hover:after:bg-sidebar-border lg:block',
        state === 'collapsed' && 'cursor-e-resize',
        className
      )}
      {...props}
    />
  )
}

function SidebarInset({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot='sidebar-inset'
      className={cn(
        'flex h-svh min-h-0 min-w-0 flex-1 flex-col overflow-hidden',
        className
      )}
      {...props}
    />
  )
}

export {
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
  SidebarRail,
  SidebarTrigger,
  useSidebar,
}

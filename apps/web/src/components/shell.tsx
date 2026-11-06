'use client';
import type { Permission } from '@crm/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  Bell,
  Building2,
  CalendarClock,
  ChartColumn,
  ChevronDown,
  CreditCard,
  Headset,
  HeartPulse,
  Layers,
  LayoutDashboard,
  ListOrdered,
  LogOut,
  Menu as MenuIcon,
  PhoneCall,
  PhoneOutgoing,
  Plug,
  ScrollText,
  Settings,
  ShieldCheck,
  Upload,
  UserCog,
  UserRound,
  Users,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';
import { api, errorMessage } from '@/lib/api';
import { formatDateTime, titleCase } from '@/lib/format';
import { homePath, meKey, usePermissions, useSignOut } from '@/lib/session';
import type { Me } from '@/lib/types';
import { cn, PRODUCT_NAME } from '@/lib/utils';
import { SimulatedBadge } from './ui/badge';
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from './ui/menu';

interface NavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  show: boolean;
}

function useNav(): { tenant: NavItem[]; platform: NavItem[] } {
  const { can, role, me } = usePermissions();
  const p = (perm: Permission) => can(perm);
  const agent = role === 'AGENT';
  return {
    tenant: me?.membership
      ? [
          { href: '/agent', label: 'Calling console', icon: Headset, show: p('calls:dial') },
          { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, show: role === 'ORG_ADMIN' },
          { href: '/supervisor', label: 'Live board', icon: Activity, show: p('monitor:view') },
          { href: '/leads', label: agent ? 'My leads' : 'Leads', icon: Users, show: true },
          { href: '/imports', label: 'Imports', icon: Upload, show: p('leads:import') },
          { href: '/callbacks', label: 'Callbacks', icon: CalendarClock, show: true },
          { href: '/calls', label: agent ? 'My calls' : 'Calls', icon: PhoneCall, show: true },
          { href: '/queues', label: 'Queues', icon: ListOrdered, show: p('queues:manage') },
          { href: '/reports', label: 'Reports', icon: ChartColumn, show: p('reports:read') },
          { href: '/team', label: 'Team', icon: UserCog, show: p('users:read') },
          { href: '/compliance', label: 'Compliance', icon: ShieldCheck, show: p('compliance:read') },
          { href: '/settings', label: 'Settings', icon: Settings, show: p('org:settings:manage') },
          { href: '/integrations', label: 'Integrations', icon: Plug, show: p('org:integrations:manage') },
          { href: '/billing', label: 'Billing', icon: CreditCard, show: p('billing:read') },
          { href: '/audit', label: 'Audit log', icon: ScrollText, show: p('audit:read') },
        ].filter((i) => i.show)
      : [],
    platform: me?.user.isPlatformAdmin
      ? [
          { href: '/platform', label: 'Organisations', icon: Building2, show: true },
          { href: '/platform/plans', label: 'Plans', icon: Layers, show: true },
          { href: '/platform/health', label: 'System health', icon: HeartPulse, show: true },
        ]
      : [],
  };
}

function NavLinks({ items, onNavigate }: { items: NavItem[]; onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <ul className="space-y-0.5">
      {items.map((item) => {
        const active = pathname === item.href || (item.href !== '/platform' && pathname.startsWith(`${item.href}/`));
        return (
          <li key={item.href}>
            <Link
              href={item.href}
              onClick={onNavigate}
              aria-current={active ? 'page' : undefined}
              className="flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm font-medium text-ink-2 hover:bg-subtle hover:text-ink"
            >
              <item.icon className="size-4 shrink-0" />
              {item.label}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const nav = useNav();
  return (
    <nav data-sidebar className="flex h-full flex-col gap-6 overflow-y-auto px-3 py-4" aria-label="Main">
      <Link href="/" className="flex items-center gap-2 px-2.5 font-semibold tracking-tight text-ink">
        <span className="grid size-7 place-items-center rounded-md bg-brand text-white">
          <PhoneOutgoing className="size-4" aria-hidden />
        </span>
        {PRODUCT_NAME}
      </Link>
      {nav.tenant.length > 0 && <NavLinks items={nav.tenant} onNavigate={onNavigate} />}
      {nav.platform.length > 0 && (
        <div>
          <p className="px-2.5 pb-1.5 text-xs font-semibold uppercase tracking-wide text-muted">Platform</p>
          <NavLinks items={nav.platform} onNavigate={onNavigate} />
        </div>
      )}
    </nav>
  );
}

interface NotificationRow {
  id: string;
  title: string;
  body: string | null;
  readAt: string | null;
  createdAt: string;
}

function Notifications() {
  const { me, timezone } = usePermissions();
  const qc = useQueryClient();
  const enabled = !!me?.membership;
  const { data } = useQuery({ queryKey: ['notifications'], queryFn: () => api.get<{ items: NotificationRow[]; unread: number }>('/notifications'), enabled, refetchInterval: 60_000 });
  const readAll = useMutation({ mutationFn: () => api.post('/notifications/read-all'), onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }) });
  if (!enabled) return null;
  return (
    <Menu>
      <MenuTrigger className="relative rounded-md p-2 text-ink-2 hover:bg-subtle" aria-label={`Notifications${data?.unread ? `, ${data.unread} unread` : ''}`}>
        <Bell className="size-4" />
        {!!data?.unread && <span className="absolute right-1 top-1 grid min-w-4 place-items-center rounded-full bg-bad px-1 text-[10px] font-semibold text-white">{data.unread}</span>}
      </MenuTrigger>
      <MenuContent className="w-80">
        <div className="flex items-center justify-between px-2.5 py-1.5">
          <span className="text-xs font-semibold text-ink">Notifications</span>
          {!!data?.unread && (
            <button type="button" className="text-xs text-brand hover:underline" onClick={() => readAll.mutate()}>
              Mark all read
            </button>
          )}
        </div>
        <MenuSeparator />
        {data?.items.length ? (
          data.items.slice(0, 8).map((n) => (
            <div key={n.id} className={cn('rounded-md px-2.5 py-2', !n.readAt && 'bg-brand-soft/40')}>
              <p className="text-sm font-medium text-ink">{n.title}</p>
              {n.body && <p className="text-xs text-muted">{n.body}</p>}
              <p className="mt-0.5 text-[11px] text-muted">{formatDateTime(n.createdAt, timezone)}</p>
            </div>
          ))
        ) : (
          <p className="px-2.5 py-4 text-center text-xs text-muted">Nothing yet</p>
        )}
      </MenuContent>
    </Menu>
  );
}

function UserMenu() {
  const { me } = usePermissions();
  const signOut = useSignOut();
  const qc = useQueryClient();
  const router = useRouter();
  const switchOrg = async (membershipId: string) => {
    try {
      const next = await api.post<Me>('/auth/select-membership', { membershipId });
      qc.clear();
      qc.setQueryData(meKey, next);
      router.replace(homePath(next));
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };
  if (!me) return null;
  const others = me.memberships.filter((m) => m.id !== me.membership?.id && m.tenantStatus === 'ACTIVE');
  return (
    <Menu>
      <MenuTrigger className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-subtle">
        <span className="grid size-7 place-items-center rounded-full bg-subtle text-xs font-semibold text-ink-2">{me.user.name.slice(0, 1).toUpperCase()}</span>
        <span className="hidden text-left sm:block">
          <span className="block text-sm font-medium leading-tight text-ink">{me.user.name}</span>
          <span className="block text-xs leading-tight text-muted">{me.membership ? titleCase(me.membership.role) : 'Platform admin'}</span>
        </span>
        <ChevronDown className="size-4 text-muted" />
      </MenuTrigger>
      <MenuContent>
        <MenuLabel>{me.user.email}</MenuLabel>
        <MenuItem onSelect={() => router.push('/account')}>
          <UserRound /> Account
        </MenuItem>
        {others.length > 0 && <MenuSeparator />}
        {others.map((m) => (
          <MenuItem key={m.id} onSelect={() => switchOrg(m.id)}>
            <Building2 /> Switch to {m.tenantName}
          </MenuItem>
        ))}
        {me.user.isPlatformAdmin && me.membership && (
          <MenuItem onSelect={() => router.push('/platform')}>
            <Layers /> Platform administration
          </MenuItem>
        )}
        <MenuSeparator />
        <MenuItem onSelect={signOut}>
          <LogOut /> Sign out
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}

function TelephonyModeBadge() {
  const { me } = usePermissions();
  const { data } = useQuery({
    queryKey: ['telephony', 'status'],
    queryFn: () => api.get<{ simulated: boolean; configured: boolean; provider: string | null }>('/telephony/status'),
    enabled: !!me?.membership,
    staleTime: 60_000,
  });
  if (!data) return null;
  if (!data.configured) return <span className="rounded-full bg-bad-soft px-2 py-0.5 text-xs font-medium text-bad">Calling not configured</span>;
  return data.simulated ? <SimulatedBadge /> : null;
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const { me } = usePermissions();
  const [mobileOpen, setMobileOpen] = React.useState(false);
  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 border-r border-line bg-surface lg:block">
        <Sidebar />
      </aside>
      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-ink/40" onClick={() => setMobileOpen(false)} aria-hidden />
          <aside className="relative h-full w-64 bg-surface shadow-xl">
            <button type="button" className="absolute right-2 top-3 rounded p-1.5 hover:bg-subtle" aria-label="Close menu" onClick={() => setMobileOpen(false)}>
              <X className="size-4" />
            </button>
            <Sidebar onNavigate={() => setMobileOpen(false)} />
          </aside>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-line bg-surface/95 px-4 backdrop-blur">
          <button type="button" className="rounded p-1.5 hover:bg-subtle lg:hidden" aria-label="Open menu" onClick={() => setMobileOpen(true)}>
            <MenuIcon className="size-5" />
          </button>
          <div className="min-w-0 flex-1 truncate text-sm font-medium text-ink-2">{me?.membership?.tenant.name ?? 'Platform administration'}</div>
          <TelephonyModeBadge />
          <Notifications />
          <UserMenu />
        </header>
        <main className="mx-auto w-full max-w-[1400px] flex-1 px-4 py-6 sm:px-6">{children}</main>
      </div>
    </div>
  );
}

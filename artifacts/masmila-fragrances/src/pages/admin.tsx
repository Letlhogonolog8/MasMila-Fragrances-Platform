import { useEffect, useState } from 'react';
import { Link, useLocation, useSearch } from 'wouter';
import {
  AlertTriangle, ArrowRight, BadgeDollarSign, Bell, Boxes, ClipboardList, FileBarChart, Gauge, Megaphone, Network,
  Search, Settings, ShieldAlert, ShoppingCart, UserCheck, Users, UsersRound, History, Inbox, Package, TrendingUp, Wallet,
} from 'lucide-react';
import { getGetAdminSummaryQueryKey, useGetAdminSummary, type ProductPerformance, type TopSeller } from '@workspace/api-client-react';
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandShortcut } from '@/components/ui/command';
import { ErrorState, LoadingBlock, ProgressBar, RequireSignIn } from '@/components/bits';
import { AreaTrend, Bars, DashboardShell, Delta, Donut, Kpi, Meter, type ShellItem } from '@/components/dashboard';
import { money, moneyShort, periodLabel } from '@/lib/format';
import { useSeo } from '@/lib/seo';
import { useMe } from '@/lib/auth';
import { NotificationsList } from './account';
import {
  ApplicationsSection, AuditSection, CustomersSection, EnquiriesSection, FraudSection, IncentivesSection, MarketingSection,
  OrdersSection, ProductsSection, ReportsSection, ResellersSection, SettingsSection, TeamsSection,
} from './admin-sections';

type Tab = 'overview' | 'applications' | 'orders' | 'products' | 'resellers' | 'teams' | 'incentives' | 'customers' | 'enquiries' | 'fraud' | 'marketing' | 'settings' | 'reports' | 'audit' | 'notifications';

function PerfList({ title, rows, empty }: { title: string; rows: ProductPerformance[]; empty: string }) {
  const max = Math.max(...rows.map((r) => r.units), 1);
  return (
    <section className="dash-card"><h2>{title}</h2>
      {rows.length ? <div className="leaderboard">{rows.map((p, i) => (
        <div className="lb-row" key={p.sku}>
          <span className="lb-rank">{i + 1}</span>
          <div className="lb-main"><div className="lb-line"><strong>{p.name}</strong><span>{p.units} units</span></div><Meter value={p.units} max={max} /><small>{money(p.revenue)} revenue · GP {money(p.grossProfit)}</small></div>
        </div>
      ))}</div> : <p className="muted">{empty}</p>}
    </section>
  );
}

function LeaderList({ title, rows, unit }: { title: string; rows: TopSeller[]; unit: string }) {
  const max = Math.max(...rows.map((r) => r.bottles), 1);
  return (
    <section className="dash-card"><h2>{title}</h2>
      {rows.length ? <div className="leaderboard">{rows.map((s, i) => (
        <div className="lb-row" key={s.resellerCode}>
          <span className={`lb-rank ${i === 0 ? 'gold' : ''}`}>{i + 1}</span>
          <div className="lb-main"><div className="lb-line"><strong>{s.name}</strong><span>{s.bottles} {unit}</span></div><Meter value={s.bottles} max={max} tone="good" /><small>{s.resellerCode} · {s.rank} · {money(s.sales)}</small></div>
        </div>
      ))}</div> : <p className="muted">No reseller sales yet this month.</p>}
    </section>
  );
}

function Overview({ goTo }: { goTo: (t: Tab) => void }) {
  const summary = useGetAdminSummary({ query: { queryKey: getGetAdminSummaryQueryKey() } });
  if (summary.isLoading) return <LoadingBlock label="Loading the business" />;
  if (summary.error || !summary.data) return <ErrorState error={summary.error} onRetry={() => void summary.refetch()} />;
  const d = summary.data;
  const alerts = [
    d.resellers.pendingApplications ? { tab: 'applications' as Tab, text: `${d.resellers.pendingApplications} reseller application(s) awaiting approval` } : null,
    d.alerts.lowStock ? { tab: 'products' as Tab, text: `LOW STOCK ALERT: ${d.alerts.lowStock} product(s)` } : null,
    d.alerts.openFraudFlags ? { tab: 'fraud' as Tab, text: `${d.alerts.openFraudFlags} open fraud / abuse flag(s)` } : null,
    d.alerts.newEnquiries ? { tab: 'enquiries' as Tab, text: `${d.alerts.newEnquiries} new enquiry(ies)` } : null,
    d.sales.awaitingPayment ? { tab: 'orders' as Tab, text: `${d.sales.awaitingPayment} order(s) awaiting payment` } : null,
  ].filter((a): a is { tab: Tab; text: string } => a != null);
  return (
    <>
      {alerts.length ? <div className="alert-row">{alerts.map((a) => <button key={a.text} className="alert" onClick={() => goTo(a.tab)}><AlertTriangle size={14} /> {a.text}</button>)}</div> : null}
      <div className="kpi-grid">
        <Kpi tone="primary" icon={TrendingUp} label={`Sales · ${periodLabel(d.period)}`} value={moneyShort(d.sales.month)} delta={<Delta current={d.sales.month} previous={d.sales.lastMonth} />} detail={`${d.sales.ordersMonth} orders`} testId="metric-sales-month" />
        <Kpi icon={ShoppingCart} label="Today" value={moneyShort(d.sales.today)} detail={`${d.sales.ordersToday} orders · 7 days ${moneyShort(d.sales.week)}`} testId="metric-sales-today" />
        <Kpi icon={Wallet} label="Gross profit (month)" value={moneyShort(d.products.grossProfit)} detail={d.products.revenue ? `${Math.round((d.products.grossProfit / d.products.revenue) * 100)}% margin` : 'No sales yet'} />
        <Kpi icon={BadgeDollarSign} label="Incentives (month)" value={moneyShort(d.organisation.incentivesMonth)} detail={`${money(d.organisation.incentivesApproved)} approved to pay`} />
      </div>
      <div className="dash-grid-2-1">
        <section className="dash-card"><div className="card-head"><h2>Daily sales</h2><span className="muted small-text">Last 14 days</span></div><div data-testid="chart-daily-sales"><AreaTrend data={d.dailySales} /></div></section>
        <section className="dash-card"><div className="card-head"><h2>Channel mix</h2><span className="muted small-text">This month</span></div><Donut data={[{ name: 'Retail', value: d.sales.retailMonth }, { name: 'Reseller', value: d.sales.resellerMonth }]} /></section>
      </div>
      <div className="dash-grid-2-1">
        <section className="dash-card"><div className="card-head"><h2>Monthly revenue</h2><span className="muted small-text">Year to date {moneyShort(d.sales.year)}</span></div><Bars money data={d.monthlySales.map((m) => ({ label: periodLabel(m.label).split(' ')[0]!.slice(0, 3), value: m.value }))} keys={[{ key: 'value', name: 'Revenue' }]} /></section>
        <section className="dash-card" data-testid="card-contribution"><h2>Contribution target</h2>
          <ProgressBar value={d.contribution.percent} label="Target achieved" />
          <div className="summary-row"><span>Gross contribution</span><strong>{money(d.contribution.current)}</strong></div>
          <div className="summary-row"><span>Target</span><strong>{money(d.contribution.target)}</strong></div>
          <div className="summary-row"><span>Bottles sold / required</span><strong>{d.contribution.bottlesSold} / {d.contribution.bottlesRequired || '—'}</strong></div>
          <div className="summary-row"><span>Remaining</span><strong>{d.contribution.remaining} bottles</strong></div>
          <small className="muted">Revenue − product cost − incentives, before overhead.</small>
        </section>
      </div>
      <div className="kpi-grid">
        <Kpi icon={Users} label="Resellers" value={d.resellers.total} detail={`${d.resellers.active} active · ${d.resellers.inactive} inactive · ${d.resellers.newThisMonth} new`} />
        <Kpi icon={Network} label="Leaders" value={d.organisation.teamLeaders + d.organisation.managers + d.organisation.directors} detail={`${d.organisation.teamLeaders} TLs · ${d.organisation.managers} Managers · ${d.organisation.directors} Directors`} />
        <Kpi icon={Package} label="Units sold (month)" value={d.products.unitsSold} detail={`${d.products.stockUnits} in stock · ${d.products.activeProducts} products`} />
        <Kpi icon={BadgeDollarSign} label="Incentives pending" value={moneyShort(d.organisation.incentivesPending)} detail={`${money(d.organisation.incentivesPaid)} paid to date`} />
      </div>
      <div className="dashboard-grid even"><LeaderList title="Top sellers" rows={d.resellers.topSellers} unit="bottles" /><LeaderList title="Top teams" rows={d.resellers.topTeams} unit="team bottles" /></div>
      <div className="dashboard-grid even"><PerfList title="Best sellers" rows={d.products.bestSellers} empty="No sales yet this month." /><PerfList title="Slow sellers" rows={d.products.slowSellers} empty="Nothing to flag." /></div>
    </>
  );
}

const NAV: Array<ShellItem<Tab>> = [
  { id: 'overview', label: 'Dashboard', icon: Gauge, primary: true },
  { id: 'orders', label: 'Orders', icon: ShoppingCart, primary: true },
  { id: 'applications', label: 'Applications', icon: UserCheck, primary: true },
  { id: 'incentives', label: 'Incentives & payouts', icon: BadgeDollarSign, primary: true },
  { id: 'products', label: 'Products & stock', icon: Boxes },
  { id: 'resellers', label: 'Resellers', icon: Users },
  { id: 'teams', label: 'Teams', icon: Network },
  { id: 'customers', label: 'Customers', icon: UsersRound },
  { id: 'enquiries', label: 'Enquiries', icon: Inbox },
  { id: 'fraud', label: 'Fraud & abuse', icon: ShieldAlert },
  { id: 'marketing', label: 'Marketing', icon: Megaphone },
  { id: 'reports', label: 'Reports', icon: FileBarChart },
  { id: 'settings', label: 'Settings & content', icon: Settings },
  { id: 'audit', label: 'Audit log', icon: History },
  { id: 'notifications', label: 'Notifications', icon: Bell },
];

/** Ctrl/⌘ + K: jump to any admin section. */
function CommandPalette({ open, setOpen, goTo }: { open: boolean; setOpen: (o: boolean) => void; goTo: (t: Tab) => void }) {
  const [, navigate] = useLocation();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setOpen(!open); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, setOpen]);
  const run = (fn: () => void) => { setOpen(false); fn(); };
  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder="Jump to a section or page…" />
      <CommandList>
        <CommandEmpty>No matches.</CommandEmpty>
        <CommandGroup heading="Admin">
          {NAV.map(({ id, label, icon: Icon }) => <CommandItem key={id} value={label} onSelect={() => run(() => goTo(id))}><Icon size={15} /> {label}</CommandItem>)}
        </CommandGroup>
        <CommandGroup heading="Storefront">
          <CommandItem value="View storefront shop" onSelect={() => run(() => navigate('/shop'))}><ClipboardList size={15} /> View shop<CommandShortcut>/shop</CommandShortcut></CommandItem>
          <CommandItem value="Home page" onSelect={() => run(() => navigate('/'))}><ArrowRight size={15} /> Home page</CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}

export default function AdminPage() {
  const search = new URLSearchParams(useSearch());
  const [, navigate] = useLocation();
  const tab = (search.get('tab') as Tab) || 'overview';
  const setTab = (t: Tab) => navigate(`/admin?tab=${t}`);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const { data: me } = useMe();
  useSeo({ title: 'Admin workspace', noindex: true });
  const items = NAV.map((n) => (n.id === 'notifications' ? { ...n, badge: me?.unreadNotifications } : n));
  return (
    <RequireSignIn role="admin">
      <DashboardShell
        eyebrow="Mas'Mila administrator"
        title="Admin console"
        subtitle={me?.user?.email}
        items={items}
        active={tab}
        onSelect={setTab}
        actions={<>
          <button className="btn-ghost small search-trigger" onClick={() => setPaletteOpen(true)} data-testid="button-command-palette"><Search size={14} /> Search <kbd>Ctrl K</kbd></button>
          <Link href="/shop" className="btn-ghost small">Storefront <ArrowRight size={14} /></Link>
        </>}
      >
        {tab === 'overview' ? <Overview goTo={setTab} />
          : tab === 'applications' ? <ApplicationsSection />
          : tab === 'orders' ? <OrdersSection />
          : tab === 'products' ? <ProductsSection />
          : tab === 'resellers' ? <ResellersSection />
          : tab === 'teams' ? <TeamsSection />
          : tab === 'incentives' ? <IncentivesSection />
          : tab === 'customers' ? <CustomersSection />
          : tab === 'enquiries' ? <EnquiriesSection />
          : tab === 'fraud' ? <FraudSection />
          : tab === 'marketing' ? <MarketingSection />
          : tab === 'settings' ? <SettingsSection />
          : tab === 'reports' ? <ReportsSection />
          : tab === 'audit' ? <AuditSection />
          : <NotificationsList />}
      </DashboardShell>
      <CommandPalette open={paletteOpen} setOpen={setPaletteOpen} goTo={setTab} />
    </RequireSignIn>
  );
}

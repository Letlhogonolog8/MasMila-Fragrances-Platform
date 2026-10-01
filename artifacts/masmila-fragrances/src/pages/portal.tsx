import { imageFor } from '@/lib/bottle';
import { useMemo, useState } from 'react';
import { Link, useLocation, useSearch } from 'wouter';
import {
  AlertTriangle, Award, BadgeDollarSign, Download, Bell, Crown, ExternalLink, Gauge, Megaphone, MessageCircle, Minus, Network,
  Package, Plus, QrCode as QrIcon, Search, ShoppingBag, Sparkles, Target, TrendingUp, Users, Zap,
} from 'lucide-react';
import {
  getGetResellerDashboardQueryKey,
  getGetResellerOrganisationQueryKey,
  getListMarketingMaterialsQueryKey,
  getListMyOrdersQueryKey,
  getListProductsQueryKey,
  getListResellerIncentivesQueryKey,
  getListResellerSalesQueryKey,
  getListResellerTeamQueryKey,
  useGetResellerDashboard,
  useGetResellerOrganisation,
  useListMarketingMaterials,
  useListMyOrders,
  useListProducts,
  useListResellerIncentives,
  useListResellerSales,
  useListResellerTeam,
  type Organisation,
  type ResellerDashboard,
  type TeamMember,
} from '@workspace/api-client-react';
import { EmptyState, ErrorState, LoadingBlock, QrCode, RequireSignIn, ShareButtons, StatusPill } from '@/components/bits';
import { Bars, DashboardShell, Delta, Kpi, Meter, Ring, whatsappTo, type ShellItem } from '@/components/dashboard';
import { useStoreConfig } from '@/components/site';
import { useMe } from '@/lib/auth';
import { useCart } from '@/lib/cart';
import { toast } from '@/hooks/use-toast';
import { bulkDiscount, dateOnly, dateTime, discounted, humanise, money, periodLabel, rankLabel } from '@/lib/format';
import { useSeo } from '@/lib/seo';
import { referralUrl } from '@/lib/referral';
import { NotificationsList } from './account';
import { OrderDetail } from './order';

type Tab = 'overview' | 'order' | 'orders' | 'sales' | 'team' | 'organisation' | 'incentives' | 'marketing' | 'share' | 'notifications';

const monthShort = (period: string) => periodLabel(period).split(' ')[0]!.slice(0, 3);

// ------------------------------------------------------------------ overview

function Hero({ d }: { d: ResellerDashboard }) {
  return (
    <section className="portal-hero" data-testid="portal-hero">
      <div className="portal-hero-copy">
        <span className="rank-badge"><Crown size={13} /> {d.rank}</span>
        <h2 data-testid="text-welcome">Welcome, {d.firstName}.</h2>
        <p>{d.nextRank ? <>You're <strong>{d.progress}%</strong> of the way to <strong>{d.nextRank}</strong> this month.</> : <>You're at the top rank available — keep your organisation qualifying.</>}</p>
        <div className="chip-row">
          <span className={`chip ${d.status === 'Active' ? 'chip-good' : 'chip-bad'}`}>{d.status}</span>
          <span className="chip">ID {d.resellerCode}</span>
          <span className="chip">Code {d.referralCode}</span>
          {d.standing !== 'good' ? <span className="chip chip-bad">{humanise(d.standing)}</span> : null}
        </div>
      </div>
      <Ring value={d.progress} size={132} stroke={11} tone="accent" label={d.nextRank ? `to ${d.nextRank}` : 'maintained'} />
    </section>
  );
}

function Overview({ d, goTo }: { d: ResellerDashboard; goTo: (t: Tab) => void }) {
  const isLeader = d.rank !== 'Reseller';
  const prev = d.history[d.history.length - 2];
  const chart = d.history.map((h) => ({ label: monthShort(h.period), personal: h.personalBottles, team: h.teamBottles }));
  return (
    <>
      {d.warning ? <div className="alert" data-testid="dashboard-warning"><AlertTriangle size={16} /> {d.warning}</div> : null}
      <Hero d={d} />
      {!d.openingOrderCompleted ? (
        <button className="cta-strip" onClick={() => goTo('order')}><Zap size={16} /> Place your opening order of {d.openingOrderRequired} bottles to activate your account <span>Quick order →</span></button>
      ) : null}
      <div className="kpi-grid">
        <Kpi tone="primary" icon={TrendingUp} label="Personal sales this month" value={money(d.personal.sales)} delta={prev ? <Delta current={d.personal.bottles} previous={prev.personalBottles} /> : null} detail="at wholesale value" testId="metric-personal-sales" />
        <Kpi icon={Package} label="Personal bottles" value={d.personal.bottles} detail={`Target ${d.personal.target}`} testId="metric-personal-bottles" />
        <Kpi icon={Users} label="Team bottles" value={d.team.bottles} delta={prev ? <Delta current={d.team.bottles} previous={prev.teamBottles} /> : null} detail={`${d.team.activeResellers} active · ${d.team.inactiveResellers} inactive`} testId="metric-team-bottles" />
        <Kpi icon={BadgeDollarSign} label="Incentives" value={money(d.team.incentive + (d.organisation?.incentive ?? 0))} detail={`${money(d.incentives.paid)} paid to date`} testId="metric-incentives" />
      </div>
      <div className="dash-grid-2-1">
        <section className="dash-card"><div className="card-head"><h2>Bottles · last 6 months</h2></div>
          <Bars data={chart} keys={isLeader ? [{ key: 'personal', name: 'Personal' }, { key: 'team', name: 'Team' }] : [{ key: 'personal', name: 'Personal' }]} />
        </section>
        <section className="dash-card" data-testid="card-rank-progress"><h2>{d.nextRank ? `Road to ${d.nextRank}` : `Maintaining ${d.rank}`}</h2>
          <div className="req-rings">
            {d.requirements.map((r) => (
              <Ring key={r.label} size={66} stroke={6} tone={r.met ? 'good' : 'primary'} value={r.target ? (r.current / r.target) * 100 : 100} label={`${r.current}/${r.target}`} sub={r.label.replace(/^.*· /, '')} />
            ))}
          </div>
          <p className="muted small-text">Incentives are calculated only on qualifying product sales — never on recruitment. Team Leader {d.rates.teamLeader}% · Manager {d.rates.manager}%{d.rates.directorEnabled ? ` · Director ${d.rates.director}%` : ''}.</p>
        </section>
      </div>
      <div className="dash-grid-2-1">
        <section className="dash-card"><h2>Earnings</h2>
          <div className="summary-row"><span>Retail margin potential (this month)</span><strong>{money(d.personal.grossMargin)}</strong></div>
          {isLeader ? <div className="summary-row"><span>Team Leader incentive ({d.rates.teamLeader}%)</span><strong data-testid="text-tl-incentive">{money(d.team.incentive)}</strong></div> : null}
          {d.organisation ? <div className="summary-row"><span>Manager incentive ({d.rates.manager}%)</span><strong data-testid="text-manager-incentive">{money(d.organisation.incentive)}</strong></div> : null}
          <div className="pipeline">
            <div><small>Pending</small><strong>{money(d.incentives.pending)}</strong></div>
            <div><small>Approved</small><strong>{money(d.incentives.approved)}</strong></div>
            <div><small>Paid</small><strong>{money(d.incentives.paid)}</strong></div>
          </div>
        </section>
        <section className="dash-card"><h2>Share & earn</h2>
          <p className="muted small-text">{d.referralStats.visits} link visits · {d.referralStats.conversions} customer orders · {money(d.referralStats.attributedSales)} sales</p>
          <ShareButtons url={referralUrl(d.referralCode)} text={`Shop Mas'Mila fragrances with me — use my code ${d.referralCode}.`} />
          <button className="btn-ghost small" onClick={() => goTo('share')}><QrIcon size={14} /> QR code</button>
        </section>
      </div>
      <section className="dash-card">
        <h2>Recent activity</h2>
        {d.activity.length ? <div className="timeline-v">{d.activity.map((a) => <div className={`tl-item tone-${a.tone}`} key={a.id}><i /><div><strong>{a.label}</strong><span>{a.detail}</span><time>{dateTime(a.time)}</time></div></div>)}</div> : <p className="muted">No activity yet. Your first sale will show up here.</p>}
      </section>
    </>
  );
}

// ------------------------------------------------------------------ quick order

/** Reseller stock ordering at wholesale prices with a live minimum-order meter. */
function QuickOrder({ d }: { d: ResellerDashboard }) {
  const params = { limit: 200, sort: 'name' as const };
  const products = useListProducts(params, { query: { queryKey: getListProductsQueryKey(params) } });
  const config = useStoreConfig();
  const cart = useCart();
  const [, navigate] = useLocation();
  const [qty, setQty] = useState<Record<number, number>>({});
  const [filter, setFilter] = useState('');
  const minimum = d.openingOrderCompleted ? (config.data?.reorderMinimum ?? 1) : d.openingOrderRequired;
  const list = useMemo(() => (products.data ?? []).filter((p) => `${p.name} ${p.sku} ${p.family} ${p.size}`.toLowerCase().includes(filter.toLowerCase())), [products.data, filter]);
  const chosen = (products.data ?? []).filter((p) => (qty[p.id] ?? 0) > 0);
  const bottles = chosen.reduce((s, p) => s + (qty[p.id] ?? 0), 0);
  const bulk = bulkDiscount(config.data?.bulkDiscountTiers, bottles);
  const cost = chosen.reduce((s, p) => s + discounted(p.resellerPrice ?? p.price, bulk.percent) * (qty[p.id] ?? 0), 0);
  const retail = chosen.reduce((s, p) => s + p.price * (qty[p.id] ?? 0), 0);
  const set = (id: number, n: number) => setQty((q) => ({ ...q, [id]: Math.max(0, Math.min(500, n)) }));

  const checkout = () => {
    cart.clear();
    for (const p of chosen) cart.add(p, qty[p.id]!);
    cart.setMode('reseller');
    toast({ title: `${bottles} bottles added`, description: 'Review delivery details to place your stock order.' });
    navigate('/checkout');
  };

  if (products.isLoading) return <LoadingBlock label="Loading reseller prices" />;
  if (products.error) return <ErrorState error={products.error} onRetry={() => void products.refetch()} />;
  return (
    <div className="quick-order">
      <div className="toolbar">
        <label className="search-box admin-search"><Search size={15} /><input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter by name, SKU, family or size" aria-label="Filter products" /></label>
        <span className="muted small-text">{d.openingOrderCompleted ? 'Re-order' : 'Opening order'} minimum {minimum} bottle{minimum === 1 ? '' : 's'} · mix any fragrances</span>
      </div>
      <div className="qo-grid">
        {list.map((p) => {
          const n = qty[p.id] ?? 0;
          const soldOut = p.stockStatus === 'out_of_stock';
          return (
            <div key={p.id} className={`qo-card ${n ? 'on' : ''} ${soldOut ? 'dim' : ''}`} data-testid={`qo-${p.sku}`}>
              <img src={imageFor(p)} alt="" loading="lazy" />
              <div className="qo-info">
                <strong>{p.name}</strong><small>{p.size} · {p.family}</small>
                <span className="qo-price">{money(p.resellerPrice ?? p.price)} <s>{money(p.price)}</s></span>
                <small className="ok-text">+{money(p.price - (p.resellerPrice ?? p.price))} margin each</small>
              </div>
              <div className="qty small">
                <button type="button" onClick={() => set(p.id, n - 1)} disabled={!n} aria-label={`Fewer ${p.name}`}><Minus size={12} /></button>
                <input value={n} inputMode="numeric" aria-label={`Quantity of ${p.name} ${p.size}`} onChange={(e) => set(p.id, Number(e.target.value.replace(/\D/g, '')) || 0)} disabled={soldOut} />
                <button type="button" onClick={() => set(p.id, n + 1)} disabled={soldOut} aria-label={`More ${p.name}`}><Plus size={12} /></button>
              </div>
            </div>
          );
        })}
      </div>
      <div className="qo-bar" data-testid="quick-order-bar">
        <div className="qo-progress">
          <div className="lb-line"><strong>{bottles} / {minimum} bottles</strong><span>{bottles >= minimum ? 'Minimum met' : `${minimum - bottles} to go`}</span></div>
          <Meter value={bottles} max={minimum} tone={bottles >= minimum ? 'good' : 'primary'} />
        </div>
        <div className="qo-totals">
          <small>You pay{bulk.percent ? ` · bulk ${bulk.percent}% off` : ''}</small><strong>{money(cost)}</strong>
          <small className="ok-text">Retail value {money(retail)} · margin {money(retail - cost)}</small>
          {bulk.next ? <small data-testid="text-next-tier">Add {bulk.next.minBottles - bottles} more for {bulk.next.percent}% off</small> : null}
        </div>
        <button className="btn-primary" disabled={bottles < minimum} onClick={checkout} data-testid="button-quick-checkout"><ShoppingBag size={15} /> Checkout</button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ team & organisation

function TeamLeaderboard({ members, target, leaderName }: { members: TeamMember[]; target: number; leaderName: string }) {
  if (!members.length) return <EmptyState title="No team members yet.">Share your referral link with people who want to sell Mas'Mila. Recruitment itself never earns commission — you earn on your team's product sales.</EmptyState>;
  const sorted = [...members].sort((a, b) => b.personalBottles - a.personalBottles);
  const max = Math.max(target, ...sorted.map((m) => m.personalBottles), 1);
  return (
    <div className="leaderboard" data-testid="table-team">
      {sorted.map((m, i) => {
        const nudge = whatsappTo(m.mobile, m.status === 'Inactive'
          ? `Hi ${m.name.split(' ')[0]}, it's ${leaderName} from Mas'Mila. Just checking in — anything I can help with to get your first sales this month?`
          : `Hi ${m.name.split(' ')[0]}, great work this month! You're on ${m.personalBottles} bottles — let's push for ${target}.`);
        return (
          <div className={`lb-row ${m.status === 'Inactive' ? 'dim' : ''}`} key={m.id}>
            <span className={`lb-rank ${i === 0 && m.personalBottles ? 'gold' : ''}`}>{i + 1}</span>
            <div className="lb-main">
              <div className="lb-line"><strong>{m.name} <small>{m.rank}</small></strong><span>{m.personalBottles} bottles</span></div>
              <Meter value={m.personalBottles} max={max} tone={m.status === 'Inactive' ? 'muted' : m.personalBottles >= target ? 'good' : 'primary'} />
              <small>{m.resellerCode} · last order {dateOnly(m.lastOrderAt)}{m.directs ? ` · ${m.teamBottles} team bottles (${m.directs} directs)` : ''}</small>
            </div>
            <div className="lb-actions">
              <StatusPill status={m.status} />
              {nudge ? <a className="btn-ghost small" href={nudge} target="_blank" rel="noreferrer" data-testid={`nudge-${m.resellerCode}`}><MessageCircle size={13} /> {m.status === 'Inactive' ? 'Check in' : 'Cheer'}</a> : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function TeamTab({ d }: { d: ResellerDashboard }) {
  const team = useListResellerTeam({ query: { queryKey: getListResellerTeamQueryKey() } });
  if (team.isLoading) return <LoadingBlock />;
  if (team.error) return <ErrorState error={team.error} onRetry={() => void team.refetch()} />;
  const members = team.data!;
  const inactive = members.filter((m) => m.status === 'Inactive');
  return (
    <>
      <div className="kpi-grid">
        <Kpi tone="primary" icon={Users} label="Direct team" value={members.length} detail={`${members.length - inactive.length} active · ${inactive.length} inactive`} />
        <Kpi icon={Package} label="Team bottles" value={d.team.bottles} detail={`Target ${d.team.target}`} />
        <Kpi icon={BadgeDollarSign} label="Team Leader incentive" value={money(d.team.incentive)} detail={`${d.rates.teamLeader}% of qualifying team sales`} />
        <Kpi icon={Award} label="Qualification" value={d.team.qualified ? 'Qualified' : 'Not yet'} detail="Team Leader requirements this month" />
      </div>
      <div className="dash-grid-2-1">
        <section className="dash-card"><div className="card-head"><h2>Team leaderboard</h2><span className="muted small-text">This month</span></div><TeamLeaderboard members={members} target={d.personal.target} leaderName={d.firstName} /></section>
        <section className="dash-card"><h2>Team target</h2>
          <Ring value={d.team.target ? (d.team.bottles / d.team.target) * 100 : 0} size={140} stroke={12} label={`${d.team.bottles} / ${d.team.target}`} sub="qualifying team bottles" />
          {inactive.length ? <div className="notice mt">{inactive.length} inactive: {inactive.map((m) => m.name.split(' ')[0]).join(', ')}. A quick WhatsApp check-in goes a long way.</div> : <p className="ok-text mt">Everyone on your team is active this month.</p>}
        </section>
      </div>
    </>
  );
}

/** Manager performance report: 6-month trend plus every leader in the organisation, as CSV (opens in Excel). */
function downloadOrgReport(d: ResellerDashboard, o: Organisation) {
  const cell = (v: string | number) => {
    const text = String(v);
    return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  const rows: Array<Array<string | number>> = [
    [`Mas'Mila organisation report — ${d.name} (${d.resellerCode})`],
    [`Period`, periodLabel(d.period)],
    [],
    ['Month', 'Personal bottles', 'Team bottles', 'Organisation bottles', 'Incentives (R)'],
    ...d.history.map((h) => [periodLabel(h.period), h.personalBottles, h.teamBottles, h.orgBottles, h.incentive.toFixed(2)]),
    [],
    ['Organisation this month', '', '', o.orgBottles, ''],
    ['Organisation sales (R)', o.orgSales.toFixed(2)],
    ['Active resellers', `${o.activeMembers} of ${o.totalMembers}`],
    [],
    ['Leader', 'Reseller ID', 'Rank', 'Status', 'Personal bottles', 'Team bottles', 'Directs', 'Last order'],
    ...o.teamLeaders.map((t) => [t.name, t.resellerCode, t.rank, t.status, t.personalBottles, t.teamBottles, t.directs, t.lastOrderAt ? t.lastOrderAt.slice(0, 10) : '']),
  ];
  const csv = '﻿' + rows.map((r) => r.map(cell).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `masmila-organisation-${d.period}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function OrganisationTab({ d }: { d: ResellerDashboard }) {
  const org = useGetResellerOrganisation({ query: { queryKey: getGetResellerOrganisationQueryKey() } });
  if (org.isLoading) return <LoadingBlock />;
  if (org.error) return <ErrorState error={org.error} onRetry={() => void org.refetch()} />;
  const o = org.data!;
  const stats = d.organisation!;
  const reqs = d.requirements.filter((r) => r.label.startsWith('Maintain') || r.label.startsWith('Director'));
  return (
    <>
      <div className="kpi-grid">
        <Kpi tone="primary" icon={TrendingUp} label="Organisation sales" value={money(o.orgSales)} detail={`${o.orgBottles} bottles this month`} />
        <Kpi icon={Network} label="Team Leaders" value={stats.teamLeaders} detail="qualifying this month" />
        <Kpi icon={Users} label="Active resellers" value={o.activeMembers} detail={`of ${o.totalMembers} in organisation`} />
        <Kpi icon={BadgeDollarSign} label="Manager incentive" value={money(stats.incentive)} detail={stats.qualified ? 'Qualified this month' : 'Not yet qualified'} />
      </div>
      <section className="dash-card"><h2>Qualification</h2>
        <div className="req-rings">{reqs.map((r) => <Ring key={r.label} size={84} stroke={8} tone={r.met ? 'good' : 'primary'} value={r.target ? (r.current / r.target) * 100 : 100} label={`${r.current}/${r.target}`} sub={r.label.replace(/^.*· /, '')} />)}</div>
      </section>
      <section className="dash-card"><div className="card-head"><h2>Team Leaders</h2><span className="muted small-text">Team volume vs {d.team.target}-bottle target</span>
        <button className="btn-ghost small" onClick={() => downloadOrgReport(d, o)} data-testid="button-org-report"><Download size={14} /> Performance report (CSV)</button></div>
        {o.teamLeaders.length ? (
          <div className="org-grid">
            {o.teamLeaders.map((tl) => {
              const pct = d.team.target ? (tl.teamBottles / d.team.target) * 100 : 0;
              const chat = whatsappTo(tl.mobile, `Hi ${tl.name.split(' ')[0]}, it's ${d.firstName}. Quick check-in on your team's month — how can I help?`);
              return (
                <div className={`org-card ${tl.status === 'Inactive' ? 'dim' : ''}`} key={tl.id}>
                  <Ring value={pct} size={70} stroke={7} tone={pct >= 100 ? 'good' : 'primary'} />
                  <div><strong>{tl.name}</strong><small>{tl.rank} · {tl.resellerCode}</small>
                    <div className="org-stats"><span><b>{tl.teamBottles}</b> team</span><span><b>{tl.personalBottles}</b> own</span><span><b>{tl.directs}</b> directs</span></div>
                    {chat ? <a className="small-link" href={chat} target="_blank" rel="noreferrer"><MessageCircle size={12} /> WhatsApp</a> : null}
                  </div>
                </div>
              );
            })}
          </div>
        ) : <p className="muted">No Team Leaders in your organisation yet.</p>}
      </section>
    </>
  );
}

// ------------------------------------------------------------------ other tabs

function IncentivesTab({ d }: { d: ResellerDashboard }) {
  const ledger = useListResellerIncentives({ query: { queryKey: getListResellerIncentivesQueryKey() } });
  return (
    <>
      <div className="dash-grid-2-1">
        <section className="dash-card"><div className="card-head"><h2>Incentives · last 6 months</h2></div><Bars money data={d.history.map((h) => ({ label: monthShort(h.period), value: h.incentive }))} keys={[{ key: 'value', name: 'Incentives' }]} /></section>
        <section className="dash-card"><h2>Payout pipeline</h2>
          <div className="pipeline vertical">
            <div><small>Pending — awaiting month-end qualification & approval</small><strong>{money(d.incentives.pending)}</strong></div>
            <div><small>Approved — in the next payout</small><strong>{money(d.incentives.approved)}</strong></div>
            <div><small>Paid to date</small><strong>{money(d.incentives.paid)}</strong></div>
          </div>
        </section>
      </div>
      {ledger.isLoading ? <LoadingBlock /> : ledger.error ? <ErrorState error={ledger.error} onRetry={() => void ledger.refetch()} /> : !ledger.data!.length ? <EmptyState title="No incentives yet.">Incentives appear when your team's product sales qualify. Status flows Pending → Approved → Paid.</EmptyState> : (
        <section className="dash-card"><h2>Ledger</h2>
          <p className="muted small-text">Refunds and cancellations reverse the related incentive automatically.</p>
          <div className="table-wrap"><table className="table" data-testid="table-incentives">
            <thead><tr><th>Date</th><th>Order</th><th>From</th><th>Type</th><th className="num">Qty</th><th className="num">Wholesale</th><th className="num">Rate</th><th className="num">Incentive</th><th>Status</th></tr></thead>
            <tbody>{ledger.data!.map((r) => (
              <tr key={r.id} className={r.status === 'void' || r.status === 'reversed' ? 'dim' : ''}>
                <td>{dateOnly(r.createdAt)}<small>{r.period}</small></td><td>{r.orderNumber}<small>{r.productName}</small></td><td>{r.seller}</td>
                <td>{r.entryType === 'reversal' ? 'Reversal' : rankLabel(r.kind)}</td><td className="num">{r.quantity}</td><td className="num">{money(r.baseValue)}</td><td className="num">{r.rate}%</td>
                <td className="num"><strong>{money(r.amount)}</strong></td>
                <td><StatusPill status={r.status} />{r.status === 'pending' ? <small>{humanise(r.qualificationStatus)}</small> : null}{r.note ? <small title={r.note}>{r.note}</small> : null}</td>
              </tr>
            ))}</tbody>
          </table></div>
        </section>
      )}
    </>
  );
}

function OrdersTab({ goTo }: { goTo: (t: Tab) => void }) {
  const orders = useListMyOrders({ query: { queryKey: getListMyOrdersQueryKey() } });
  if (orders.isLoading) return <LoadingBlock />;
  const mine = (orders.data ?? []).filter((o) => o.channel === 'reseller');
  if (!mine.length) return <div className="empty-state"><h2>No stock orders yet.</h2><p>Use Quick order to build a mixed order at reseller prices.</p><button className="btn-primary" onClick={() => goTo('order')}><Zap size={15} /> Quick order</button></div>;
  return <div className="order-list">{mine.map((o) => <div className="dash-card" key={o.id}><OrderDetail order={o} /></div>)}</div>;
}

function SalesTab() {
  const sales = useListResellerSales({ query: { queryKey: getListResellerSalesQueryKey() } });
  if (sales.isLoading) return <LoadingBlock />;
  if (!sales.data?.length) return <EmptyState title="No attributed customer sales yet.">When customers buy through your referral link, QR code or code, the sale shows here.</EmptyState>;
  return (
    <section className="dash-card"><h2>Customer sales through your link</h2>
      <div className="table-wrap"><table className="table">
        <thead><tr><th>Order</th><th>Customer</th><th>Status</th><th className="num">Bottles</th><th className="num">Value</th></tr></thead>
        <tbody>{sales.data.map((o) => <tr key={o.id}><td>{o.orderNumber}<small>{dateTime(o.createdAt)}</small></td><td>{o.customerName}<small>{o.shippingAddress}</small></td><td><StatusPill status={o.status} /></td><td className="num">{o.bottles}</td><td className="num">{money(o.subtotal)}</td></tr>)}</tbody>
      </table></div>
    </section>
  );
}

function MarketingTab() {
  const materials = useListMarketingMaterials({ query: { queryKey: getListMarketingMaterialsQueryKey() } });
  if (materials.isLoading) return <LoadingBlock />;
  if (!materials.data?.length) return <EmptyState title="No materials yet." />;
  return (
    <div className="material-grid">
      {materials.data.map((m) => (
        <a key={m.id} className="material-card" href={m.url} target="_blank" rel="noreferrer" data-testid={`material-${m.id}`}>
          <span className="eyebrow">{humanise(m.category)}{m.minRank !== 'reseller' ? ` · ${rankLabel(m.minRank)}s` : ''}</span>
          <strong>{m.title}</strong><span>{m.description}</span><small>Open <ExternalLink size={12} /></small>
        </a>
      ))}
    </div>
  );
}

function ShareTab({ d }: { d: ResellerDashboard }) {
  return (
    <div className="dash-grid-2-1">
      <section className="dash-card">
        <h2>Your referral tools</h2>
        <div className="kv"><span>Reseller ID</span><strong className="font-mono-brand">{d.resellerCode}</strong></div>
        <div className="kv"><span>Referral code</span><strong className="font-mono-brand" data-testid="text-referral-code">{d.referralCode}</strong></div>
        <div className="kv"><span>Referral URL</span><strong className="font-mono-brand small-text" data-testid="text-referral-url">{referralUrl(d.referralCode)}</strong></div>
        <p className="muted small-text">Customers who buy through your link, QR code or code are attributed to you for 30 days. Self-referrals are not attributed.</p>
        <ShareButtons url={referralUrl(d.referralCode)} text={`Shop Mas'Mila fragrances with me — use my code ${d.referralCode}.`} />
        <div className="pipeline"><div><small>Link visits</small><strong>{d.referralStats.visits}</strong></div><div><small>Customer orders</small><strong>{d.referralStats.conversions}</strong></div><div><small>Sales</small><strong>{money(d.referralStats.attributedSales)}</strong></div></div>
      </section>
      <section className="dash-card" style={{ textAlign: 'center' }}>
        <h2>QR code</h2>
        <QrCode value={referralUrl(d.referralCode, 'qr')} />
        <p className="muted small-text">Print it for events, stalls and packaging.</p>
      </section>
    </div>
  );
}

// ------------------------------------------------------------------ page

export default function PortalPage() {
  useSeo({ title: 'Reseller portal', noindex: true });
  return <RequireSignIn role="reseller"><PortalInner /></RequireSignIn>;
}

function PortalInner() {
  const search = new URLSearchParams(useSearch());
  const [, navigate] = useLocation();
  const tab = (search.get('tab') as Tab) || 'overview';
  const setTab = (t: Tab) => navigate(`/account/reseller?tab=${t}`);
  const { data: me } = useMe();
  const dashboard = useGetResellerDashboard({ query: { queryKey: getGetResellerDashboardQueryKey() } });
  if (dashboard.isLoading) return <main className="container-wide dashboard-wrap"><LoadingBlock label="Loading your portal" /></main>;
  if (dashboard.error || !dashboard.data) return <main className="container-wide dashboard-wrap"><ErrorState error={dashboard.error} onRetry={() => void dashboard.refetch()} /></main>;
  const d = dashboard.data;
  const hasTeam = d.rank !== 'Reseller' || d.team.activeResellers + d.team.inactiveResellers > 0;
  const items: Array<ShellItem<Tab>> = [
    { id: 'overview', label: 'Dashboard', icon: Gauge, primary: true },
    { id: 'order', label: 'Quick order', icon: Zap, primary: true },
    ...(hasTeam ? [{ id: 'team' as Tab, label: 'Team', icon: Users, primary: true }] : []),
    ...(d.organisation ? [{ id: 'organisation' as Tab, label: 'Organisation', icon: Network }] : []),
    { id: 'incentives', label: 'Incentives', icon: BadgeDollarSign, primary: true },
    { id: 'share', label: 'Share & QR', icon: QrIcon, primary: !hasTeam },
    { id: 'orders', label: 'My orders', icon: Package },
    { id: 'sales', label: 'Customer sales', icon: Target },
    { id: 'marketing', label: 'Marketing', icon: Megaphone },
    { id: 'notifications', label: 'Notifications', icon: Bell, badge: me?.unreadNotifications },
  ];
  return (
    <DashboardShell
      eyebrow={`Reseller portal · ${d.resellerCode}`}
      title={d.name}
      subtitle={<><Crown size={12} /> {d.rank} · {d.status}</>}
      items={items}
      active={tab}
      onSelect={setTab}
      actions={<Link href="/shop" className="btn-ghost small"><Sparkles size={14} /> Browse shop</Link>}
    >
      {tab === 'order' ? <QuickOrder d={d} />
        : tab === 'orders' ? <OrdersTab goTo={setTab} />
        : tab === 'sales' ? <SalesTab />
        : tab === 'team' ? <TeamTab d={d} />
        : tab === 'organisation' && d.organisation ? <OrganisationTab d={d} />
        : tab === 'incentives' ? <IncentivesTab d={d} />
        : tab === 'marketing' ? <MarketingTab />
        : tab === 'share' ? <ShareTab d={d} />
        : tab === 'notifications' ? <NotificationsList />
        : <Overview d={d} goTo={setTab} />}
    </DashboardShell>
  );
}

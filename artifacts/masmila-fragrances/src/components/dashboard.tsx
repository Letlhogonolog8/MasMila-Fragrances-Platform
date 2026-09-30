import { type ReactNode, useState } from 'react';
import { ArrowDownRight, ArrowUpRight, Minus, MoreHorizontal, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

// ------------------------------------------------------------------ app shell

export type ShellItem<T extends string> = { id: T; label: string; icon: LucideIcon; badge?: number; primary?: boolean };

/**
 * App-style layout for signed-in areas: a sidebar on desktop, and on phones a
 * bottom tab bar with the primary sections plus a "More" sheet for the rest.
 */
export function DashboardShell<T extends string>({
  eyebrow,
  title,
  subtitle,
  items,
  active,
  onSelect,
  actions,
  children,
}: {
  eyebrow: string;
  title: ReactNode;
  subtitle?: ReactNode;
  items: Array<ShellItem<T>>;
  active: T;
  onSelect: (id: T) => void;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const [moreOpen, setMoreOpen] = useState(false);
  const primary = items.filter((i) => i.primary).slice(0, 4);
  const current = items.find((i) => i.id === active);
  const select = (id: T) => { setMoreOpen(false); onSelect(id); };
  return (
    <div className="container-wide shell">
      <aside className="shell-side" aria-label="Section navigation">
        <div className="shell-identity"><span className="eyebrow">{eyebrow}</span><strong>{title}</strong>{subtitle ? <small>{subtitle}</small> : null}</div>
        <nav className="shell-nav">
          {items.map(({ id, label, icon: Icon, badge }) => (
            <button key={id} type="button" className={`shell-link ${active === id ? 'on' : ''}`} onClick={() => select(id)} aria-current={active === id ? 'page' : undefined} data-testid={`nav-${id}`}>
              <Icon size={16} /><span>{label}</span>{badge ? <em>{badge > 99 ? '99+' : badge}</em> : null}
            </button>
          ))}
        </nav>
      </aside>
      <section className="shell-main">
        <header className="shell-head">
          <div><span className="eyebrow mobile-eyebrow">{eyebrow}</span><h1 className="display-md">{current?.label ?? ''}</h1></div>
          {actions ? <div className="shell-actions">{actions}</div> : null}
        </header>
        {children}
      </section>
      <nav className="bottom-bar" aria-label="Quick navigation">
        {primary.map(({ id, label, icon: Icon, badge }) => (
          <button key={id} type="button" className={active === id ? 'on' : ''} onClick={() => select(id)}>
            <span className="bb-icon"><Icon size={19} />{badge ? <em /> : null}</span>{label}
          </button>
        ))}
        <button type="button" className={!primary.some((p) => p.id === active) ? 'on' : ''} onClick={() => setMoreOpen(true)}><span className="bb-icon"><MoreHorizontal size={19} /></span>More</button>
      </nav>
      {moreOpen ? (
        <div className="sheet-backdrop" onClick={() => setMoreOpen(false)} role="presentation">
          <div className="sheet" role="dialog" aria-label="All sections" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-head"><strong>All sections</strong><button className="icon-button" onClick={() => setMoreOpen(false)} aria-label="Close"><X size={16} /></button></div>
            <div className="sheet-grid">
              {items.map(({ id, label, icon: Icon, badge }) => (
                <button key={id} type="button" className={active === id ? 'on' : ''} onClick={() => select(id)}><Icon size={20} /><span>{label}</span>{badge ? <em>{badge}</em> : null}</button>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------ data display

/** Circular progress ring (0–100). */
export function Ring({ value, size = 88, stroke = 8, label, sub, tone = 'primary' }: { value: number; size?: number; stroke?: number; label?: ReactNode; sub?: ReactNode; tone?: 'primary' | 'good' | 'accent' }) {
  const pct = Math.max(0, Math.min(100, value));
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <div className="pring" style={{ width: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`${Math.round(pct)}%`}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="hsl(var(--muted))" strokeWidth={stroke} />
        <circle
          cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} strokeLinecap="round"
          className={`pring-arc pring-${tone}`}
          strokeDasharray={c} strokeDashoffset={c * (1 - pct / 100)}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
        <text x="50%" y="50%" dominantBaseline="central" textAnchor="middle" className="pring-text" style={{ fontSize: size * 0.22 }}>{Math.round(pct)}%</text>
      </svg>
      {label ? <strong className="pring-label">{label}</strong> : null}
      {sub ? <small className="pring-sub">{sub}</small> : null}
    </div>
  );
}

/** Change vs a previous value, e.g. "▲ 12% vs last month". */
export function Delta({ current, previous, suffix = 'vs last month' }: { current: number; previous: number; suffix?: string }) {
  if (!previous && !current) return <span className="delta flat"><Minus size={12} /> no change</span>;
  if (!previous) return <span className="delta up"><ArrowUpRight size={12} /> new {suffix}</span>;
  const pct = Math.round(((current - previous) / Math.abs(previous)) * 100);
  const dir = pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat';
  const Icon = dir === 'up' ? ArrowUpRight : dir === 'down' ? ArrowDownRight : Minus;
  return <span className={`delta ${dir}`}><Icon size={12} /> {Math.abs(pct)}% {suffix}</span>;
}

/** KPI tile with an optional icon and change indicator. */
export function Kpi({ label, value, icon: Icon, delta, detail, tone, testId }: { label: string; value: ReactNode; icon?: LucideIcon; delta?: ReactNode; detail?: ReactNode; tone?: 'primary' | 'ink'; testId?: string }) {
  return (
    <div className={`kpi ${tone ? `kpi-${tone}` : ''}`} data-testid={testId}>
      <div className="kpi-top"><span className="metric-label">{label}</span>{Icon ? <span className="kpi-icon"><Icon size={16} /></span> : null}</div>
      <span className="kpi-value">{value}</span>
      {delta ?? null}
      {detail ? <span className="metric-detail">{detail}</span> : null}
    </div>
  );
}

const PRIMARY = 'hsl(var(--primary))';
const INK = 'hsl(var(--secondary))';
const ACCENT = 'hsl(65 55% 45%)';
const MUTED = 'hsl(var(--muted-foreground))';
const axis = { fontSize: 11, fill: MUTED } as const;

function ChartTooltip({ money: isMoney = false }: { money?: boolean }) {
  return (
    <Tooltip
      cursor={{ fill: 'hsl(var(--muted))', opacity: 0.5 }}
      contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: 8, fontSize: 12 }}
      formatter={(v: number, name: string) => [isMoney ? `R${Number(v).toLocaleString('en-ZA', { maximumFractionDigits: 0 })}` : v, name]}
    />
  );
}

export function AreaTrend({ data, height = 220, money: isMoney = true, name = 'Revenue' }: { data: Array<{ label: string; value: number }>; height?: number; money?: boolean; name?: string }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 10, right: 6, left: -10, bottom: 0 }}>
        <defs>
          <linearGradient id="areaFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={PRIMARY} stopOpacity={0.35} />
            <stop offset="100%" stopColor={PRIMARY} stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
        <XAxis dataKey="label" tick={axis} tickLine={false} axisLine={false} />
        <YAxis tick={axis} tickLine={false} axisLine={false} width={52} tickFormatter={(v: number) => (isMoney ? `R${v >= 1000 ? `${Math.round(v / 1000)}k` : v}` : String(v))} />
        <ChartTooltip money={isMoney} />
        <Area type="monotone" dataKey="value" name={name} stroke={PRIMARY} strokeWidth={2.5} fill="url(#areaFill)" />
      </AreaChart>
    </ResponsiveContainer>
  );
}

export function Bars<K extends string>({ data, keys, height = 220, money: isMoney = false }: { data: Array<Record<string, string | number>>; keys: Array<{ key: K; name: string }>; height?: number; money?: boolean }) {
  const colors = [PRIMARY, INK, ACCENT];
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 10, right: 6, left: -10, bottom: 0 }} barGap={4}>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
        <XAxis dataKey="label" tick={axis} tickLine={false} axisLine={false} />
        <YAxis tick={axis} tickLine={false} axisLine={false} width={52} tickFormatter={(v: number) => (isMoney ? `R${v >= 1000 ? `${Math.round(v / 1000)}k` : v}` : String(v))} />
        <ChartTooltip money={isMoney} />
        {keys.length > 1 ? <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} /> : null}
        {keys.map((k, i) => <Bar key={k.key} dataKey={k.key} name={k.name} fill={colors[i % colors.length]} radius={[5, 5, 0, 0]} maxBarSize={36} />)}
      </BarChart>
    </ResponsiveContainer>
  );
}

export function Donut({ data, height = 200 }: { data: Array<{ name: string; value: number }>; height?: number }) {
  const colors = [PRIMARY, INK, ACCENT];
  const total = data.reduce((s, d) => s + d.value, 0);
  return (
    <div className="donut">
      <ResponsiveContainer width="100%" height={height}>
        <PieChart>
          <Pie data={total ? data : [{ name: 'No sales', value: 1 }]} dataKey="value" nameKey="name" innerRadius="62%" outerRadius="90%" paddingAngle={total ? 2 : 0} stroke="none">
            {(total ? data : [{ name: '', value: 1 }]).map((_, i) => <Cell key={i} fill={total ? colors[i % colors.length] : 'hsl(var(--muted))'} />)}
          </Pie>
          {total ? <ChartTooltip money /> : null}
        </PieChart>
      </ResponsiveContainer>
      <ul className="donut-legend">
        {data.map((d, i) => <li key={d.name}><i style={{ background: colors[i % colors.length] }} />{d.name}<strong>{total ? `${Math.round((d.value / total) * 100)}%` : '—'}</strong></li>)}
      </ul>
    </div>
  );
}

/** Thin horizontal meter used in leaderboards. */
export function Meter({ value, max, tone = 'primary' }: { value: number; max: number; tone?: 'primary' | 'good' | 'muted' }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return <span className={`meter meter-${tone}`}><span style={{ width: `${pct}%` }} /></span>;
}

/** South African mobile → WhatsApp link (0821234567 → 27821234567). */
export function whatsappTo(mobile: string | null | undefined, text: string) {
  if (!mobile) return null;
  const digits = mobile.replace(/\D/g, '');
  const intl = digits.startsWith('0') ? `27${digits.slice(1)}` : digits;
  return `https://wa.me/${intl}?text=${encodeURIComponent(text)}`;
}

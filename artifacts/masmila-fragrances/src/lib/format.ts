export const money = (value: number | null | undefined) =>
  `R${(value ?? 0).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const moneyShort = (value: number) =>
  `R${value.toLocaleString('en-ZA', { maximumFractionDigits: 0 })}`;

export const RANK_LABELS: Record<string, string> = {
  reseller: 'Reseller',
  team_leader: 'Team Leader',
  manager: 'Manager',
  director: 'Director',
};

export const rankLabel = (rank: string) => RANK_LABELS[rank] ?? rank;

export const humanise = (value: string) =>
  value.replaceAll('_', ' ').replace(/^\w/, (c) => c.toUpperCase());

export function dateTime(value: string | null | undefined) {
  if (!value) return '—';
  return new Date(value).toLocaleString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function dateOnly(value: string | null | undefined) {
  if (!value) return '—';
  return new Date(value).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function periodLabel(period: string) {
  const [y, m] = period.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, 1)).toLocaleDateString('en-ZA', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

export function currentPeriod() {
  const d = new Date(Date.now() + 2 * 3600 * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function shiftPeriod(period: string, months: number) {
  const [y, m] = period.split('-').map(Number);
  const d = new Date(Date.UTC(y!, m! - 1 + months, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export const PROVINCES = [
  'Eastern Cape', 'Free State', 'Gauteng', 'KwaZulu-Natal', 'Limpopo', 'Mpumalanga', 'North West', 'Northern Cape', 'Western Cape',
];

/** Bulk pricing tiers ("50:5,100:10") → sorted [{ minBottles, percent }]. Mirrors the server. */
export function bulkTiers(value: string | undefined) {
  return (value ?? '')
    .split(',')
    .map((pair) => pair.trim().split(':').map(Number))
    .filter(([min, pct]) => Number.isFinite(min) && Number.isFinite(pct) && pct! > 0 && pct! < 100)
    .map(([min, pct]) => ({ minBottles: min!, percent: pct! }))
    .sort((a, b) => a.minBottles - b.minBottles);
}

/** Bulk discount (%) for a reseller order of `bottles`, and the next tier to aim for. */
export function bulkDiscount(value: string | undefined, bottles: number) {
  const tiers = bulkTiers(value);
  const current = tiers.filter((t) => bottles >= t.minBottles).pop() ?? null;
  const next = tiers.find((t) => bottles < t.minBottles) ?? null;
  return { percent: current?.percent ?? 0, next };
}

/** Unit price after a bulk discount, rounded to cents exactly as the server does. */
export const discounted = (price: number, percent: number) => Math.round(price * (1 - percent / 100) * 100) / 100;

/** Friendly message from an ApiError (or anything else). */
export function errorMessage(error: unknown, fallback = 'Something went wrong. Please try again.') {
  const data = (error as { data?: { error?: string } } | null)?.data;
  if (data && typeof data.error === 'string') return data.error;
  return fallback;
}

export const statusTone = (status: string): 'good' | 'warn' | 'bad' | 'neutral' => {
  if (['active', 'Active', 'paid', 'approved', 'delivered', 'good', 'qualified', 'resolved', 'closed', 'shipped'].includes(status)) return 'good';
  if (['pending', 'awaiting_payment', 'processing', 'review', 'info_requested', 'provisional', 'partially_refunded', 'new', 'in_progress', 'medium', 'hold'].includes(status)) return 'warn';
  if (['inactive', 'Inactive', 'cancelled', 'refunded', 'rejected', 'suspended', 'void', 'reversed', 'not_qualified', 'open', 'high'].includes(status)) return 'bad';
  return 'neutral';
};

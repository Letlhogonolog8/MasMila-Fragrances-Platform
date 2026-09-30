/**
 * Qualification periods are calendar months in South African Standard Time
 * (UTC+2, no daylight saving). Periods are represented as "YYYY-MM".
 */
const SAST_OFFSET_MS = 2 * 60 * 60 * 1000;
const PERIOD_RE = /^(\d{4})-(\d{2})$/;

export function periodOf(date: Date): string {
  const d = new Date(date.getTime() + SAST_OFFSET_MS);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export const currentPeriod = () => periodOf(new Date());

function parse(period: string): [number, number] {
  const match = PERIOD_RE.exec(period);
  if (!match) throw new Error(`Invalid period "${period}"`);
  return [Number(match[1]), Number(match[2])];
}

export function shiftPeriod(period: string, months: number): string {
  const [year, month] = parse(period);
  const d = new Date(Date.UTC(year, month - 1 + months, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export const previousPeriod = (period: string) => shiftPeriod(period, -1);

/** UTC instants for the start (inclusive) and end (exclusive) of a period. */
export function periodBounds(period: string): { start: Date; end: Date } {
  const [year, month] = parse(period);
  return {
    start: new Date(Date.UTC(year, month - 1, 1) - SAST_OFFSET_MS),
    end: new Date(Date.UTC(year, month, 1) - SAST_OFFSET_MS),
  };
}

/** Start of the SAST calendar day containing `date`, as a UTC instant. */
export function startOfDay(date: Date): Date {
  const d = new Date(date.getTime() + SAST_OFFSET_MS);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - SAST_OFFSET_MS);
}

export function sastDateLabel(date: Date): string {
  return new Date(date.getTime() + SAST_OFFSET_MS).toISOString().slice(0, 10);
}

export const isPeriod = (value: string) => PERIOD_RE.test(value);

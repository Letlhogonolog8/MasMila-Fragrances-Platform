import { db, commissionLedgerTable, ordersTable, resellerApplicationsTable } from "@workspace/db";
import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { RANK_LABELS } from "./engine";
import { evaluatePeriod, PAID_STATUSES, resellerNames } from "./network";
import { currentPeriod, periodBounds, periodOf, sastDateLabel, shiftPeriod, startOfDay } from "./period";
import { round2 } from "./http";

export type ReportType = "daily" | "weekly" | "monthly" | "products" | "resellers" | "teams" | "commissions" | "orders";
export type Report = { title: string; columns: string[]; rows: string[][] };

const DAY = 24 * 3600 * 1000;
const money = (n: number) => round2(n).toFixed(2);

function range(from?: string, to?: string, defaultDays = 30) {
  const end = to ? new Date(`${to}T00:00:00+02:00`).getTime() + DAY : startOfDay(new Date()).getTime() + DAY;
  const start = from ? new Date(`${from}T00:00:00+02:00`).getTime() : end - defaultDays * DAY;
  if (Number.isNaN(start) || Number.isNaN(end) || start >= end) throw new Error("Invalid date range");
  return { start: new Date(start), end: new Date(Math.min(end, start + 800 * DAY)) };
}

/** Paid order lines in a window with net (post-refund) quantities. */
async function lines(start: Date, end: Date) {
  const rows = await db.execute<{
    order_id: number;
    channel: string;
    paid_at: Date;
    customer_email: string;
    seller: number | null;
    product_id: number;
    name: string;
    sku: string;
    size: string;
    qty: number;
    revenue: string;
    wholesale: string;
    cost: string;
  }>(sql`
    select o.id as order_id, o.channel, o.paid_at, o.customer_email,
      case when o.channel = 'reseller' then o.reseller_id else o.attributed_reseller_id end as seller,
      i.product_id, i.name, i.sku, i.size,
      (i.quantity - i.refunded_quantity)::int as qty,
      ((i.quantity - i.refunded_quantity) * i.unit_price)::text as revenue,
      ((i.quantity - i.refunded_quantity) * i.unit_wholesale)::text as wholesale,
      ((i.quantity - i.refunded_quantity) * i.unit_cost)::text as cost
    from orders o join order_items i on i.order_id = o.id
    where o.paid_at >= ${start} and o.paid_at < ${end} and o.status in ${PAID_STATUSES}
  `);
  return rows.rows.map((r) => ({
    ...r,
    paidAt: new Date(r.paid_at),
    qty: Number(r.qty),
    revenue: Number(r.revenue),
    wholesale: Number(r.wholesale),
    cost: Number(r.cost),
  }));
}

type Line = Awaited<ReturnType<typeof lines>>[number];

function bucketTotals(list: Line[]) {
  return {
    orders: new Set(list.map((l) => l.order_id)).size,
    revenue: list.reduce((s, l) => s + l.revenue, 0),
    retail: list.filter((l) => l.channel === "retail").reduce((s, l) => s + l.revenue, 0),
    reseller: list.filter((l) => l.channel === "reseller").reduce((s, l) => s + l.revenue, 0),
    cost: list.reduce((s, l) => s + l.cost, 0),
    bottles: list.reduce((s, l) => s + l.qty, 0),
  };
}

async function incentivesBetween(periodFrom: string, periodTo: string) {
  const rows = await db
    .select({ period: commissionLedgerTable.period, total: sql<string>`sum(${commissionLedgerTable.amount})` })
    .from(commissionLedgerTable)
    .where(
      and(
        gte(commissionLedgerTable.period, periodFrom),
        sql`${commissionLedgerTable.period} <= ${periodTo}`,
        inArray(commissionLedgerTable.status, ["pending", "approved", "paid"]),
      ),
    )
    .groupBy(commissionLedgerTable.period);
  return new Map(rows.map((r) => [r.period, Number(r.total)]));
}

export async function buildReport(type: ReportType, from?: string, to?: string): Promise<Report> {
  switch (type) {
    case "daily": {
      const { start, end } = range(from, to, 14);
      const data = await lines(start, end);
      const rows: string[][] = [];
      for (let t = end.getTime() - DAY; t >= start.getTime(); t -= DAY) {
        const day = data.filter((l) => l.paidAt.getTime() >= t && l.paidAt.getTime() < t + DAY);
        const b = bucketTotals(day);
        rows.push([sastDateLabel(new Date(t)), String(b.orders), money(b.revenue), String(b.bottles), money(b.revenue - b.cost)]);
      }
      return { title: "Daily sales", columns: ["Date", "Orders", "Revenue (R)", "Bottles sold", "Gross profit (R)"], rows };
    }
    case "weekly": {
      const { start, end } = range(from, to, 12 * 7);
      const data = await lines(start, end);
      const rows: string[][] = [];
      for (let t = end.getTime() - 7 * DAY; t > start.getTime() - 7 * DAY; t -= 7 * DAY) {
        const ws = Math.max(t, start.getTime());
        const week = data.filter((l) => l.paidAt.getTime() >= ws && l.paidAt.getTime() < t + 7 * DAY);
        const b = bucketTotals(week);
        const sellers = new Set(week.filter((l) => l.channel === "reseller").map((l) => l.seller));
        const teamSales = week.filter((l) => l.seller != null).reduce((s, l) => s + l.wholesale, 0);
        const byProduct = new Map<string, number>();
        for (const l of week) byProduct.set(`${l.name} ${l.size}`, (byProduct.get(`${l.name} ${l.size}`) ?? 0) + l.qty);
        const top = [...byProduct.entries()].sort((a, c) => c[1] - a[1]).slice(0, 3).map(([n, q]) => `${n} (${q})`).join("; ");
        rows.push([`${sastDateLabel(new Date(ws))} → ${sastDateLabel(new Date(t + 6 * DAY))}`, money(b.revenue), String(b.bottles), String(sellers.size), money(teamSales), top || "—"]);
      }
      return { title: "Weekly sales & activity", columns: ["Week", "Sales (R)", "Bottles", "Active reseller buyers", "Reseller/team volume at wholesale (R)", "Top products"], rows };
    }
    case "monthly": {
      const lastPeriod = to ? to.slice(0, 7) : currentPeriod();
      const firstPeriod = from ? from.slice(0, 7) : shiftPeriod(lastPeriod, -11);
      const start = periodBounds(firstPeriod).start;
      const end = periodBounds(lastPeriod).end;
      const [data, incentives, registrations, allOrders] = await Promise.all([
        lines(start, end),
        incentivesBetween(firstPeriod, lastPeriod),
        db
          .select({ period: sql<string>`to_char(${resellerApplicationsTable.createdAt} at time zone 'Africa/Johannesburg', 'YYYY-MM')`, count: sql<number>`count(*)::int` })
          .from(resellerApplicationsTable)
          .where(and(gte(resellerApplicationsTable.createdAt, start), lt(resellerApplicationsTable.createdAt, end)))
          .groupBy(sql`1`),
        db
          .select({ email: ordersTable.customerEmail, paidAt: ordersTable.paidAt })
          .from(ordersTable)
          .where(and(inArray(ordersTable.status, PAID_STATUSES), eq(ordersTable.channel, "retail"), lt(ordersTable.paidAt, end))),
      ]);
      const firstOrder = new Map<string, number>();
      for (const o of allOrders) {
        if (!o.paidAt) continue;
        const t = o.paidAt.getTime();
        if (!firstOrder.has(o.email) || t < firstOrder.get(o.email)!) firstOrder.set(o.email, t);
      }
      const regs = new Map(registrations.map((r) => [r.period, r.count]));
      const rows: string[][] = [];
      for (let p = lastPeriod; p >= firstPeriod; p = shiftPeriod(p, -1)) {
        const month = data.filter((l) => periodOf(l.paidAt) === p);
        const b = bucketTotals(month);
        const inc = incentives.get(p) ?? 0;
        const gross = b.revenue - b.cost;
        const retailBuyers = new Map<string, number>();
        for (const l of month.filter((x) => x.channel === "retail")) retailBuyers.set(l.customer_email, (retailBuyers.get(l.customer_email) ?? 0) + 1);
        const { start: ps, end: pe } = periodBounds(p);
        const newCustomers = [...retailBuyers.keys()].filter((e) => {
          const t = firstOrder.get(e);
          return t != null && t >= ps.getTime() && t < pe.getTime();
        }).length;
        const repeat = [...retailBuyers.keys()].length - newCustomers;
        const activeResellers = new Set(month.filter((l) => l.seller != null).map((l) => l.seller)).size;
        rows.push([p, money(b.retail), money(b.reseller), money(b.cost), money(gross), money(inc), money(gross - inc), String(activeResellers), String(regs.get(p) ?? 0), String(newCustomers), String(repeat), String(b.bottles)]);
      }
      return {
        title: "Monthly performance",
        columns: ["Month", "Retail revenue (R)", "Reseller revenue (R)", "Product costs (R)", "Gross profit (R)", "Incentives (R)", "Net contribution before overhead (R)", "Active resellers", "New reseller registrations", "New customers", "Repeat customers", "Bottles"],
        rows,
      };
    }
    case "products": {
      const { start, end } = range(from, to, 30);
      const data = await lines(start, end);
      const products = await db.execute<{ id: number; name: string; sku: string; size: string; stock: number; reserved: number; status: string }>(
        sql`select id, name, sku, size, stock_quantity as stock, reserved_quantity as reserved, status from products order by name, size`,
      );
      const rows = products.rows.map((p) => {
        const mine = data.filter((l) => l.product_id === p.id);
        const units = mine.reduce((s, l) => s + l.qty, 0);
        const revenue = mine.reduce((s, l) => s + l.revenue, 0);
        const cost = mine.reduce((s, l) => s + l.cost, 0);
        return [p.name, p.size, p.sku, p.status, String(units), money(revenue), money(cost), money(revenue - cost), String(p.stock), String(p.reserved)];
      });
      rows.sort((a, c) => Number(c[4]) - Number(a[4]));
      return { title: "Product performance", columns: ["Product", "Size", "SKU", "Status", "Units sold", "Revenue (R)", "Cost (R)", "Gross profit (R)", "Stock", "Reserved"], rows };
    }
    case "resellers":
    case "teams": {
      const period = to ? to.slice(0, 7) : currentPeriod();
      const snapshot = await evaluatePeriod(period);
      const names = await resellerNames([...snapshot.resellers.keys()]);
      const all = [...snapshot.resellers.values()];
      const list = type === "teams" ? all.filter((r) => (snapshot.children.get(r.id)?.length ?? 0) > 0) : all;
      const rows = list
        .map((r) => {
          const s = snapshot.stats.get(r.id)!;
          const sponsor = r.sponsorId != null ? names.get(r.sponsorId)?.code ?? "" : "";
          return type === "teams"
            ? [r.resellerCode, names.get(r.id)?.name ?? "", RANK_LABELS[r.rank] ?? r.rank, String(snapshot.children.get(r.id)?.length ?? 0), String(s.activeDirects), String(s.inactiveDirects), String(s.teamBottles), money(s.teamSales), String(s.orgBottles), money(s.orgSales), RANK_LABELS[s.qualifiedRank]!]
            : [r.resellerCode, names.get(r.id)?.name ?? "", RANK_LABELS[r.rank] ?? r.rank, s.isActive ? "Active" : "Inactive", r.standing, sponsor, String(s.personalBottles), money(s.personalSales), String(s.teamBottles), r.lastOrderAt ? sastDateLabel(r.lastOrderAt) : ""];
        })
        .sort((a, c) => Number(c[type === "teams" ? 6 : 6]) - Number(a[type === "teams" ? 6 : 6]));
      return type === "teams"
        ? { title: `Team activity · ${period}`, columns: ["Leader", "Name", "Rank", "Directs", "Active", "Inactive", "Team bottles", "Team sales (R)", "Org bottles", "Org sales (R)", "Qualifies as"], rows }
        : { title: `Reseller activity · ${period}`, columns: ["Reseller ID", "Name", "Rank", "Status", "Standing", "Sponsor", "Personal bottles", "Personal sales (R)", "Team bottles", "Last order"], rows };
    }
    case "commissions": {
      const lastPeriod = to ? to.slice(0, 7) : currentPeriod();
      const firstPeriod = from ? from.slice(0, 7) : shiftPeriod(lastPeriod, -2);
      const rows = await db
        .select()
        .from(commissionLedgerTable)
        .where(and(gte(commissionLedgerTable.period, firstPeriod), sql`${commissionLedgerTable.period} <= ${lastPeriod}`))
        .orderBy(commissionLedgerTable.period, commissionLedgerTable.id);
      const names = await resellerNames(rows.flatMap((r) => [r.beneficiaryResellerId, r.sellerResellerId]));
      return {
        title: "Commission ledger",
        columns: ["Entry", "Type", "Period", "Order", "Product", "Qty", "Seller", "Beneficiary", "Kind", "Rank", "Rate %", "Wholesale value (R)", "Incentive (R)", "Qualification", "Status", "Note", "Created"],
        rows: rows.map((r) => [String(r.id), r.entryType, r.period, r.orderNumber, r.productName, String(r.quantity), names.get(r.sellerResellerId)?.code ?? "", names.get(r.beneficiaryResellerId)?.code ?? "", r.kind, RANK_LABELS[r.beneficiaryRank] ?? r.beneficiaryRank, String(r.rate), money(r.baseValue), money(r.amount), r.qualificationStatus, r.status, r.note ?? "", r.createdAt.toISOString()]),
      };
    }
    case "orders": {
      const { start, end } = range(from, to, 30);
      const rows = await db
        .select()
        .from(ordersTable)
        .where(and(gte(ordersTable.createdAt, start), lt(ordersTable.createdAt, end)))
        .orderBy(ordersTable.createdAt);
      const names = await resellerNames(rows.flatMap((o) => [o.resellerId, o.attributedResellerId]).filter((x): x is number => x != null));
      return {
        title: "Orders",
        columns: ["Order", "Created", "Channel", "Status", "Customer", "Email", "Province", "Bottles", "Subtotal (R)", "Shipping (R)", "Total (R)", "Wholesale (R)", "Cost (R)", "Reseller", "Attributed to", "Source", "Courier", "Tracking"],
        rows: rows.map((o) => [o.orderNumber, o.createdAt.toISOString(), o.channel, o.status, `${o.customerFirstName} ${o.customerSurname}`, o.customerEmail, o.province, String(o.bottles), money(o.subtotal), money(o.shippingFee), money(o.total), money(o.wholesaleValue), money(o.costValue), o.resellerId ? names.get(o.resellerId)?.code ?? "" : "", o.attributedResellerId ? names.get(o.attributedResellerId)?.code ?? "" : "", o.attributionSource ?? "", o.courier ?? "", o.trackingNumber ?? ""]),
      };
    }
  }
}

export function toCsv(report: Report) {
  // Neutralise spreadsheet formula injection (=, +, @, or "-" not followed by a number).
  const formula = /^(?:[=+@]|-(?![\d.]))/;
  const escape = (raw: string) => {
    const value = formula.test(raw) ? `'${raw}` : raw;
    return /[",\n\r]/.test(value) || value !== raw ? `"${value.replaceAll('"', '""')}"` : value;
  };
  // BOM so Excel opens UTF-8 (e.g. Mas'Mila, é) correctly.
  return "﻿" + [report.columns, ...report.rows].map((row) => row.map(escape).join(",")).join("\r\n");
}


import { db, fraudFlagsTable, ordersTable, resellerApplicationsTable, usersTable, type Order } from "@workspace/db";
import { and, eq, gte, ne, sql } from "drizzle-orm";
import { notifyAdmins } from "./notify";
import { getSettings } from "./settings";

type FlagInput = {
  type: string;
  severity: "low" | "medium" | "high";
  detail: string;
  resellerId?: number | null;
  orderId?: number | null;
  userId?: number | null;
};

export async function raiseFlag(flag: FlagInput) {
  await db.insert(fraudFlagsTable).values({
    type: flag.type,
    severity: flag.severity,
    detail: flag.detail,
    resellerId: flag.resellerId ?? null,
    orderId: flag.orderId ?? null,
    userId: flag.userId ?? null,
  });
  await notifyAdmins("suspicious_activity", `Review needed: ${flag.type.replaceAll("_", " ")}`, flag.detail, "/admin?tab=fraud");
}

const normaliseMobile = (mobile: string) => mobile.replace(/\D/g, "").replace(/^27/, "0");

/** Duplicate orders, unusual order velocity and large orders. */
export async function checkOrder(order: Order) {
  const settings = await getSettings();
  const since = new Date(Date.now() - 30 * 60 * 1000);
  const [duplicate] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(ordersTable)
    .where(
      and(
        eq(ordersTable.customerEmail, order.customerEmail),
        eq(ordersTable.total, order.total),
        ne(ordersTable.id, order.id),
        ne(ordersTable.status, "cancelled"),
        gte(ordersTable.createdAt, since),
      ),
    );
  if ((duplicate?.count ?? 0) > 0) {
    await raiseFlag({
      type: "duplicate_order",
      severity: "medium",
      detail: `Order ${order.orderNumber} matches another order for ${order.customerEmail} with the same total in the last 30 minutes.`,
      orderId: order.id,
      userId: order.userId,
    });
  }

  const [velocity] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(ordersTable)
    .where(and(eq(ordersTable.customerEmail, order.customerEmail), gte(ordersTable.createdAt, new Date(Date.now() - 24 * 3600 * 1000))));
  if ((velocity?.count ?? 0) >= 5) {
    await raiseFlag({
      type: "unusual_order",
      severity: "medium",
      detail: `${velocity!.count} orders from ${order.customerEmail} in 24 hours (latest ${order.orderNumber}).`,
      orderId: order.id,
      userId: order.userId,
    });
  }

  if (order.attributedResellerId != null) {
    const [repeat] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(ordersTable)
      .where(
        and(
          eq(ordersTable.attributedResellerId, order.attributedResellerId),
          eq(ordersTable.customerMobile, order.customerMobile),
          ne(ordersTable.customerEmail, order.customerEmail),
        ),
      );
    if ((repeat?.count ?? 0) > 0) {
      await raiseFlag({
        type: "suspicious_referral",
        severity: "medium",
        detail: `Referral order ${order.orderNumber} shares a mobile number with attributed orders placed under a different email address.`,
        orderId: order.id,
        resellerId: order.attributedResellerId,
      });
    }
  }

  if (order.bottles >= settings.largeOrderBottles) {
    await notifyAdmins(
      "large_order",
      "Large order received",
      `${order.orderNumber}: ${order.bottles} bottles · R${order.total.toFixed(2)} (${order.channel}).`,
      "/admin?tab=orders",
    );
  }
}

/** Multiple accounts / applications sharing an email or mobile number. */
export async function duplicateIdentityWarnings(input: { email: string; mobile: string; excludeApplicationId?: number }) {
  const mobile = normaliseMobile(input.mobile);
  const warnings: string[] = [];
  const users = await db
    .select({ email: usersTable.email, mobile: usersTable.mobile })
    .from(usersTable)
    .where(sql`regexp_replace(regexp_replace(coalesce(${usersTable.mobile}, ''), '\\D', '', 'g'), '^27', '0') = ${mobile}`);
  for (const u of users) if (u.email !== input.email.toLowerCase()) warnings.push(`Mobile also used by account ${u.email}`);
  const apps = await db
    .select({ id: resellerApplicationsTable.id, applicationId: resellerApplicationsTable.applicationId, email: resellerApplicationsTable.email, mobile: resellerApplicationsTable.mobile, status: resellerApplicationsTable.status })
    .from(resellerApplicationsTable)
    .where(sql`lower(${resellerApplicationsTable.email}) = ${input.email.toLowerCase()} or regexp_replace(regexp_replace(${resellerApplicationsTable.mobile}, '\\D', '', 'g'), '^27', '0') = ${mobile}`);
  for (const a of apps) {
    if (a.id === input.excludeApplicationId) continue;
    warnings.push(`Matches application ${a.applicationId} (${a.status}) — ${a.email === input.email ? "same email" : "same mobile"}`);
  }
  return warnings;
}

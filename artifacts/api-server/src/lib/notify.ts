import { db, notificationsTable, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";

/**
 * Notifications are stored in-app and, when RESEND_API_KEY is configured,
 * also emailed. Delivery failures never break the calling flow.
 * (WhatsApp Business API delivery is a Phase 3 channel and plugs in here.)
 */
async function sendEmail(to: string, subject: string, text: string) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.NOTIFY_FROM_EMAIL;
  if (!apiKey || !from) {
    logger.debug({ to, subject }, "Email delivery not configured; skipped");
    return false;
  }
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to, subject, text }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Resend responded ${response.status}`);
    return true;
  } catch (err) {
    logger.warn({ err, subject }, "Email delivery failed");
    return false;
  }
}

const siteUrl = () => (process.env.SITE_URL ?? "https://masmila.co.za").replace(/\/$/, "");

export async function notifyUser(
  userId: number,
  type: string,
  title: string,
  body: string,
  link?: string,
) {
  try {
    const [row] = await db
      .insert(notificationsTable)
      .values({ userId, type, title, body, link: link ?? null })
      .returning({ id: notificationsTable.id });
    const [user] = await db.select({ email: usersTable.email }).from(usersTable).where(eq(usersTable.id, userId));
    if (user && (await sendEmail(user.email, `Mas'Mila · ${title}`, `${body}${link ? `\n\n${siteUrl()}${link}` : ""}`))) {
      await db.update(notificationsTable).set({ emailedAt: new Date() }).where(eq(notificationsTable.id, row!.id));
    }
  } catch (err) {
    logger.error({ err, type }, "Failed to notify user");
  }
}

/** One notification to many users (campaigns/announcements): a single insert, emails sent in the background. */
export async function notifyMany(
  recipients: Array<{ id: number; email: string }>,
  type: string,
  title: string,
  body: string,
  link?: string,
) {
  if (!recipients.length) return 0;
  for (let i = 0; i < recipients.length; i += 500) {
    await db.insert(notificationsTable).values(
      recipients.slice(i, i + 500).map((r) => ({ userId: r.id, type, title, body, link: link ?? null })),
    );
  }
  void (async () => {
    for (const r of recipients) await sendEmail(r.email, `Mas'Mila · ${title}`, `${body}${link ? `\n\n${siteUrl()}${link}` : ""}`);
  })();
  return recipients.length;
}

export async function notifyAdmins(type: string, title: string, body: string, link?: string) {
  try {
    await db.insert(notificationsTable).values({ audience: "admin", type, title, body, link: link ?? null });
    for (const email of adminEmails()) {
      void sendEmail(email, `Mas'Mila admin · ${title}`, body);
    }
  } catch (err) {
    logger.error({ err, type }, "Failed to notify admins");
  }
}

/** For guests without an account (e.g. retail checkout). */
export async function notifyEmail(to: string, title: string, body: string) {
  await sendEmail(to, `Mas'Mila · ${title}`, body);
}

export function adminEmails(): string[] {
  return (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}

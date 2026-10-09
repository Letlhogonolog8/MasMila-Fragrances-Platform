import type { NextFunction, Request, RequestHandler, Response } from "express";
import { clerkClient, getAuth } from "@clerk/express";
import { db, resellersTable, usersTable, type Reseller, type User } from "@workspace/db";
import { eq, getTableColumns, sql } from "drizzle-orm";
import { adminEmails, notifyUser } from "./notify";
import { databaseUnavailable, forbidden, HttpError } from "./http";
import { logger } from "./logger";
import { clerkConfigured, demoAuthAllowed, verifiedPrimaryEmail } from "./runtime-env";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      currentUser?: User | null;
      currentReseller?: Reseller | null;
    }
  }
}

export const clerkEnabled = clerkConfigured();
/**
 * Demo auth lets developers sign in as any email (including seeded admin
 * accounts) without a password. It only exists when NODE_ENV is explicitly
 * "development" or "test" and Clerk is not configured; production refuses to
 * start if DEMO_AUTH is requested (see runtime-env.ts).
 */
export const demoAuthEnabled = demoAuthAllowed();
export const authMode: "clerk" | "demo" | "none" = clerkEnabled ? "clerk" : demoAuthEnabled ? "demo" : "none";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Finds or creates the account for a verified email (exported for tests). */
export async function upsertUserByEmail(
  email: string,
  details: { clerkUserId?: string; firstName?: string | null; surname?: string | null },
): Promise<User | null> {
  const role = adminEmails().includes(email) ? "admin" : "customer";
  const [row] = await db
    .insert(usersTable)
    .values({
      email,
      role,
      clerkUserId: details.clerkUserId ?? null,
      firstName: details.firstName ?? "",
      surname: details.surname ?? "",
      lastSeenAt: new Date(),
    })
    .onConflictDoUpdate({
      target: usersTable.email,
      set: {
        lastSeenAt: new Date(),
        // Link an unclaimed account only; never move it to a different Clerk user.
        ...(details.clerkUserId ? { clerkUserId: sql`coalesce(${usersTable.clerkUserId}, ${details.clerkUserId})` } : {}),
        // Promote configured admin emails; never silently demote anyone.
        ...(role === "admin" ? { role: "admin" } : {}),
        firstName: sql`case when ${usersTable.firstName} = '' then ${details.firstName ?? ""} else ${usersTable.firstName} end`,
        surname: sql`case when ${usersTable.surname} = '' then ${details.surname ?? ""} else ${usersTable.surname} end`,
      },
    })
    // xmax = 0 only for a freshly inserted row, i.e. a brand-new account.
    .returning({ ...getTableColumns(usersTable), created: sql<boolean>`(xmax = 0)` });
  const { created, ...user } = row!;
  if (details.clerkUserId && user.clerkUserId !== details.clerkUserId) {
    logger.warn({ userId: user.id }, "Sign-in refused: this email's account is already linked to a different Clerk user");
    return null;
  }
  if (created) {
    await notifyUser(
      user.id,
      "account_created",
      "Welcome to Mas'Mila",
      "Your account is ready. Track orders, save your address and build a wishlist — or apply to become a reseller.",
      "/account",
    );
  }
  return user;
}

async function resolveUser(req: Request): Promise<User | null> {
  if (clerkEnabled) {
    const { userId } = getAuth(req);
    if (!userId) return null;
    const [existing] = await db.select().from(usersTable).where(eq(usersTable.clerkUserId, userId));
    if (existing) return existing;
    const clerkUser = await clerkClient.users.getUser(userId);
    const email = verifiedPrimaryEmail(clerkUser);
    if (!email) {
      logger.warn({ clerkUserId: userId }, "Sign-in refused: Clerk primary email is missing or unverified");
      return null;
    }
    return upsertUserByEmail(email, {
      clerkUserId: userId,
      firstName: clerkUser.firstName,
      surname: clerkUser.lastName,
    });
  }
  if (demoAuthEnabled) {
    const match = /^Bearer demo:(.+)$/i.exec(req.headers.authorization ?? "");
    if (!match) return null;
    const email = decodeURIComponent(match[1]!).trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return null;
    return upsertUserByEmail(email, {});
  }
  return null;
}

/** Attaches `req.currentUser` / `req.currentReseller` for every API request. */
export const loadSession: RequestHandler = async (req, _res, next) => {
  try {
    const user = await resolveUser(req);
    req.currentUser = user;
    req.currentReseller = null;
    if (user) {
      const [reseller] = await db.select().from(resellersTable).where(eq(resellersTable.userId, user.id));
      req.currentReseller = reseller ?? null;
    }
  } catch (err) {
    // Database timeout or outage: answer 503 (retry), not "signed out" (401/403).
    if (databaseUnavailable(err)) return next(err);
    logger.warn({ err }, "Could not resolve session");
    req.currentUser = null;
    req.currentReseller = null;
  }
  next();
};

export function requireUser(req: Request, _res: Response, next: NextFunction) {
  const user = req.currentUser;
  if (!user) return next(new HttpError(401, "Please sign in to continue."));
  if (user.accountStatus === "suspended") return next(forbidden("This account has been suspended. Please contact Mas'Mila."));
  next();
}

/** Approved reseller whose account is not suspended. */
export function requireReseller(req: Request, res: Response, next: NextFunction) {
  requireUser(req, res, (err?: unknown) => {
    if (err) return next(err);
    const reseller = req.currentReseller;
    if (!reseller) return next(forbidden("The reseller portal is available to approved Mas'Mila resellers."));
    if (reseller.standing === "suspended") return next(forbidden("Your reseller account is suspended. Please contact Mas'Mila."));
    next();
  });
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  requireUser(req, res, (err?: unknown) => {
    if (err) return next(err);
    if (req.currentUser!.role !== "admin") return next(forbidden("Administrator access only."));
    next();
  });
}

/** Wholesale prices are shown only to approved resellers in good standing. */
export function canSeeResellerPricing(req: Request) {
  const user = req.currentUser;
  const reseller = req.currentReseller;
  return Boolean(
    user &&
      reseller &&
      user.accountStatus === "active" &&
      (reseller.standing === "good" || reseller.standing === "review"),
  );
}

import type { NextFunction, Request, RequestHandler, Response } from "express";
import { clerkClient, getAuth } from "@clerk/express";
import { db, resellersTable, usersTable, type Reseller, type User } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { adminEmails } from "./notify";
import { forbidden, HttpError } from "./http";
import { logger } from "./logger";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      currentUser?: User | null;
      currentReseller?: Reseller | null;
    }
  }
}

export const clerkEnabled = Boolean(process.env.CLERK_SECRET_KEY);
/**
 * Demo auth lets reviewers sign in as any seeded account without Clerk.
 * Off in production unless DEMO_AUTH=true is set explicitly — only for a
 * throwaway demo deployment with seeded data, since anyone can then sign in
 * as any account (including admin).
 */
export const demoAuthEnabled =
  !clerkEnabled &&
  (process.env.DEMO_AUTH === "true" ||
    (process.env.NODE_ENV !== "production" && process.env.DISABLE_DEMO_AUTH !== "true"));
export const authMode: "clerk" | "demo" | "none" = clerkEnabled ? "clerk" : demoAuthEnabled ? "demo" : "none";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function upsertUserByEmail(
  email: string,
  details: { clerkUserId?: string; firstName?: string | null; surname?: string | null },
): Promise<User> {
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
        ...(details.clerkUserId ? { clerkUserId: details.clerkUserId } : {}),
        // Promote configured admin emails; never silently demote anyone.
        ...(role === "admin" ? { role: "admin" } : {}),
        firstName: sql`case when ${usersTable.firstName} = '' then ${details.firstName ?? ""} else ${usersTable.firstName} end`,
        surname: sql`case when ${usersTable.surname} = '' then ${details.surname ?? ""} else ${usersTable.surname} end`,
      },
    })
    .returning();
  return row!;
}

async function resolveUser(req: Request): Promise<User | null> {
  if (clerkEnabled) {
    const { userId } = getAuth(req);
    if (!userId) return null;
    const [existing] = await db.select().from(usersTable).where(eq(usersTable.clerkUserId, userId));
    if (existing) return existing;
    const clerkUser = await clerkClient.users.getUser(userId);
    const email = clerkUser.primaryEmailAddress?.emailAddress?.toLowerCase();
    if (!email) return null;
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

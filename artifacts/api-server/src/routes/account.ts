import { Router, type IRouter, type Request } from "express";
import {
  AddToWishlistParams,
  GetMeResponse,
  ListMyOrdersResponse,
  ListNotificationsResponse,
  ListWishlistResponse,
  RemoveFromWishlistParams,
  SubmitResellerApplicationBody,
  SubmitResellerApplicationResponse,
  UpdateMeBody,
  UpdateMeResponse,
} from "@workspace/api-zod";
import {
  db,
  notificationsTable,
  ordersTable,
  productsTable,
  resellerApplicationsTable,
  resellersTable,
  usersTable,
  wishlistItemsTable,
} from "@workspace/db";
import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import { canSeeResellerPricing, requireUser } from "../lib/auth";
import { toPublicProduct } from "../lib/catalog";
import { serializeOrders } from "../lib/orders";
import { badRequest, HttpError } from "../lib/http";
import { applicationNumber, isUniqueViolation } from "../lib/codes";
import { audit } from "../lib/audit";
import { notifyAdmins, notifyUser } from "../lib/notify";
import { duplicateIdentityWarnings, raiseFlag } from "../lib/fraud";

const router: IRouter = Router();

function notificationScope(req: Request) {
  const user = req.currentUser!;
  return user.role === "admin"
    ? or(eq(notificationsTable.userId, user.id), and(isNull(notificationsTable.userId), eq(notificationsTable.audience, "admin")))
    : eq(notificationsTable.userId, user.id);
}

async function buildMe(req: Request) {
  const user = req.currentUser;
  if (!user) return { signedIn: false, isAdmin: false, user: null, reseller: null, application: null, unreadNotifications: 0 };
  const reseller = req.currentReseller;
  const [application] = await db
    .select()
    .from(resellerApplicationsTable)
    .where(or(eq(resellerApplicationsTable.userId, user.id), eq(resellerApplicationsTable.email, user.email)))
    .orderBy(desc(resellerApplicationsTable.createdAt))
    .limit(1);
  const [unread] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(notificationsTable)
    .where(and(notificationScope(req), isNull(notificationsTable.readAt)));
  return {
    signedIn: true,
    isAdmin: user.role === "admin",
    unreadNotifications: unread?.count ?? 0,
    user: {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      surname: user.surname,
      mobile: user.mobile,
      role: user.role,
      accountStatus: user.accountStatus,
      addressLine1: user.addressLine1,
      addressLine2: user.addressLine2,
      suburb: user.suburb,
      city: user.city,
      province: user.province,
      postalCode: user.postalCode,
      marketingOptIn: user.marketingOptIn,
    },
    reseller: reseller
      ? {
          id: reseller.id,
          resellerCode: reseller.resellerCode,
          referralCode: reseller.referralCode,
          rank: reseller.rank,
          status: reseller.status,
          standing: reseller.standing,
          openingOrderCompleted: reseller.openingOrderCompleted,
        }
      : null,
    application: application
      ? { applicationId: application.applicationId, status: application.status, adminNote: application.adminNote }
      : null,
  };
}

router.get("/me", async (req, res) => {
  res.json(GetMeResponse.parse(await buildMe(req)));
});

router.patch("/me", requireUser, async (req, res) => {
  const input = UpdateMeBody.parse(req.body);
  const [updated] = await db.update(usersTable).set(input).where(eq(usersTable.id, req.currentUser!.id)).returning();
  req.currentUser = updated!;
  await audit("profile_updated", "user", updated!.id, updated, { fields: Object.keys(input) });
  res.json(UpdateMeResponse.parse(await buildMe(req)));
});

router.get("/me/orders", requireUser, async (req, res) => {
  const user = req.currentUser!;
  const orders = await db
    .select()
    .from(ordersTable)
    .where(or(eq(ordersTable.userId, user.id), eq(ordersTable.customerEmail, user.email)))
    .orderBy(desc(ordersTable.createdAt))
    .limit(100);
  res.json(ListMyOrdersResponse.parse(await serializeOrders(orders)));
});

router.get("/me/wishlist", requireUser, async (req, res) => {
  const rows = await db
    .select({ product: productsTable })
    .from(wishlistItemsTable)
    .innerJoin(productsTable, eq(productsTable.id, wishlistItemsTable.productId))
    .where(and(eq(wishlistItemsTable.userId, req.currentUser!.id), eq(productsTable.status, "active")))
    .orderBy(desc(wishlistItemsTable.createdAt));
  const showReseller = canSeeResellerPricing(req);
  res.json(ListWishlistResponse.parse(rows.map((r) => toPublicProduct(r.product, showReseller))));
});

router.put("/me/wishlist/:productId", requireUser, async (req, res) => {
  const { productId } = AddToWishlistParams.parse(req.params);
  const [product] = await db.select({ id: productsTable.id }).from(productsTable).where(eq(productsTable.id, productId));
  if (!product) throw badRequest("That fragrance is no longer available.");
  await db.insert(wishlistItemsTable).values({ userId: req.currentUser!.id, productId }).onConflictDoNothing();
  res.json({ ok: true });
});

router.delete("/me/wishlist/:productId", requireUser, async (req, res) => {
  const { productId } = RemoveFromWishlistParams.parse(req.params);
  await db.delete(wishlistItemsTable).where(and(eq(wishlistItemsTable.userId, req.currentUser!.id), eq(wishlistItemsTable.productId, productId)));
  res.json({ ok: true });
});

router.get("/me/notifications", requireUser, async (req, res) => {
  const rows = await db
    .select()
    .from(notificationsTable)
    .where(notificationScope(req))
    .orderBy(desc(notificationsTable.createdAt))
    .limit(50);
  res.json(
    ListNotificationsResponse.parse(
      rows.map((n) => ({ id: n.id, type: n.type, title: n.title, body: n.body, link: n.link, read: Boolean(n.readAt), createdAt: n.createdAt.toISOString() })),
    ),
  );
});

router.post("/me/notifications/read", requireUser, async (req, res) => {
  await db.update(notificationsTable).set({ readAt: new Date() }).where(and(notificationScope(req), isNull(notificationsTable.readAt)));
  res.json({ ok: true });
});

/** "Become a Mas'Mila Reseller" — enters the admin approval queue. */
router.post("/reseller-applications", async (req, res) => {
  const input = SubmitResellerApplicationBody.parse(req.body);
  if (!input.termsAccepted || !input.privacyAccepted || !input.resellerTermsAccepted) {
    throw badRequest("Please accept the terms, privacy policy and reseller terms to apply.");
  }
  const email = input.email.trim().toLowerCase();
  const [existingReseller] = await db
    .select({ id: resellersTable.id })
    .from(resellersTable)
    .innerJoin(usersTable, eq(usersTable.id, resellersTable.userId))
    .where(eq(usersTable.email, email));
  if (existingReseller) throw new HttpError(409, "This email address already belongs to an approved reseller. Please sign in to your portal.");
  const [pending] = await db
    .select({ applicationId: resellerApplicationsTable.applicationId })
    .from(resellerApplicationsTable)
    .where(and(eq(resellerApplicationsTable.email, email), or(eq(resellerApplicationsTable.status, "pending"), eq(resellerApplicationsTable.status, "info_requested"))));
  if (pending) throw new HttpError(409, `You already have an application in the queue (${pending.applicationId}). We'll be in touch soon.`);

  let referringCode = input.referringCode?.trim().toUpperCase() || null;
  if (referringCode) {
    const [sponsor] = await db
      .select({ id: resellersTable.id })
      .from(resellersTable)
      .where(or(eq(resellersTable.referralCode, referringCode), eq(resellersTable.resellerCode, referringCode)));
    if (!sponsor) throw badRequest(`We couldn't find a reseller with code ${referringCode}. Check the code or leave it blank.`);
  }

  const warnings = await duplicateIdentityWarnings({ email, mobile: input.mobile });
  let row: typeof resellerApplicationsTable.$inferSelect | undefined;
  for (let attempt = 0; attempt < 5 && !row; attempt++) {
    try {
      [row] = await db
        .insert(resellerApplicationsTable)
        .values({
          applicationId: applicationNumber(),
          userId: req.currentUser?.id ?? null,
          firstName: input.firstName.trim(),
          surname: input.surname.trim(),
          mobile: input.mobile.trim(),
          email,
          province: input.province,
          city: input.city.trim(),
          contactMethod: input.contactMethod,
          heardAbout: input.heardAbout,
          referringCode,
          termsAccepted: input.termsAccepted,
          privacyAccepted: input.privacyAccepted,
          resellerTermsAccepted: input.resellerTermsAccepted,
        })
        .returning();
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
  }
  await audit("reseller_application_submitted", "reseller_application", row!.applicationId, req.currentUser, { email, referringCode });
  await notifyAdmins("reseller_application", "New reseller application", `${input.firstName} ${input.surname} (${input.city}, ${input.province}) applied${referringCode ? ` via ${referringCode}` : ""}.`, "/admin?tab=applications");
  if (warnings.length) {
    await raiseFlag({ type: "duplicate_account", severity: "medium", detail: `Application ${row!.applicationId}: ${warnings.join("; ")}` });
  }
  if (req.currentUser) {
    await notifyUser(req.currentUser.id, "application_received", "Application received", `Your reseller application ${row!.applicationId} is in the approval queue.`, "/account");
  }
  res.status(201).json(
    SubmitResellerApplicationResponse.parse({
      id: row!.applicationId,
      status: row!.status,
      message: "Your application is in the Mas'Mila approval queue. We'll be in touch shortly.",
    }),
  );
});

export default router;

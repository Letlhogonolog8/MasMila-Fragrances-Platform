import {
  db,
  enquiriesTable,
  marketingMaterialsTable,
  productsTable,
  resellerApplicationsTable,
  resellersTable,
  siteContentTable,
  usersTable,
} from "@workspace/db";
import { eq, inArray, sql } from "drizzle-orm";
import { DEFAULT_MARKETING, DEFAULT_SITE_CONTENT, LEGACY_PLACEHOLDER_IMAGES, seedProducts } from "./catalog";
import { getSettings } from "./settings";
import { resellerCodeFor } from "./codes";
import { createOrder, markOrderPaid } from "./orders";
import { logger } from "./logger";
import { adminEmails } from "./notify";

/** Idempotent base data every environment needs. */
export async function ensureBaseData() {
  await getSettings();
  const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(productsTable);
  if (count === 0) {
    await db.insert(productsTable).values(seedProducts()).onConflictDoNothing();
    logger.info("Seeded fragrance catalogue");
  }
  // Only exact seeded placeholder URLs are cleared — never an uploaded photo.
  await db.update(productsTable).set({ image: "" }).where(inArray(productsTable.image, LEGACY_PLACEHOLDER_IMAGES));
  const [{ count: materials }] =await db.select({ count: sql<number>`count(*)::int` }).from(marketingMaterialsTable);
  if (materials === 0) await db.insert(marketingMaterialsTable).values(DEFAULT_MARKETING);
  await db
    .insert(siteContentTable)
    .values(Object.entries(DEFAULT_SITE_CONTENT).map(([key, value]) => ({ key, value })))
    .onConflictDoNothing();
  for (const email of adminEmails()) {
    await db
      .insert(usersTable)
      .values({ email, role: "admin", firstName: "Mas'Mila", surname: "Admin" })
      .onConflictDoUpdate({ target: usersTable.email, set: { role: "admin" } });
  }
}

type DemoPerson = { first: string; last: string; email: string; rank: string; sponsor?: string; bottles: number; size?: "50ml" | "100ml" };

const DEMO_ADDRESS = { line1: "12 Jacaranda Street", suburb: "Hatfield", city: "Pretoria", province: "Gauteng", postalCode: "0083" };

/**
 * Demo network matching the acceptance scenario in the proposal (§48):
 * one Manager with three Team Leaders, each with five resellers selling
 * 20 bottles of 50ml at the R140 reseller price this month.
 */
export async function seedDemoNetwork() {
  const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(resellersTable);
  if (count > 0) return;
  logger.info("Seeding demo reseller network");

  await db
    .insert(usersTable)
    .values([
      { email: "admin@masmila.co.za", role: "admin", firstName: "Mila", surname: "Admin" },
      { email: "customer@masmila.co.za", role: "customer", firstName: "Palesa", surname: "Mokoena", mobile: "0820000001" },
    ])
    .onConflictDoNothing();

  const people: DemoPerson[] = [
    { first: "Thandi", last: "Mabena", email: "manager@masmila.co.za", rank: "manager", bottles: 20 },
  ];
  const leaders = [
    { first: "Nomdade", last: "Sithole", email: "teamleader@masmila.co.za" },
    { first: "Sipho", last: "Dlamini", email: "sipho@masmila.co.za" },
    { first: "Lerato", last: "Molefe", email: "lerato@masmila.co.za" },
  ];
  const firstNames = ["Ayanda", "Bongani", "Zanele", "Kagiso", "Naledi", "Tumi", "Mpho", "Lindiwe", "Sizwe", "Refilwe", "Thabo", "Karabo", "Nandi", "Lwazi", "Busi"];
  leaders.forEach((leader, li) => {
    people.push({ ...leader, rank: "team_leader", sponsor: "manager@masmila.co.za", bottles: 20 });
    for (let i = 0; i < 5; i++) {
      const first = firstNames[li * 5 + i]!;
      people.push({
        first,
        last: "Demo",
        email: li === 0 && i === 0 ? "reseller@masmila.co.za" : `${first.toLowerCase()}@masmila.co.za`,
        rank: "reseller",
        sponsor: leader.email,
        bottles: 20,
      });
    }
  });
  // One new reseller who has not placed an opening order yet.
  people.push({ first: "Kea", last: "Newcomer", email: "newreseller@masmila.co.za", rank: "reseller", sponsor: "teamleader@masmila.co.za", bottles: 0 });

  const idsByEmail = new Map<string, number>();
  let referralSeq = 100;
  for (const person of people) {
    const [user] = await db
      .insert(usersTable)
      .values({ email: person.email, role: "reseller", firstName: person.first, surname: person.last, mobile: `08${String(10000000 + referralSeq).slice(-8)}` })
      .onConflictDoUpdate({ target: usersTable.email, set: { role: "reseller" } })
      .returning();
    const [reseller] = await db
      .insert(resellersTable)
      .values({
        userId: user!.id,
        resellerCode: `TMP-${user!.id}`,
        referralCode: `${person.first.toUpperCase().replace(/[^A-Z]/g, "")}${referralSeq++}`,
        sponsorId: person.sponsor ? idsByEmail.get(person.sponsor)! : null,
        rank: person.rank,
        status: "inactive",
      })
      .returning();
    await db.update(resellersTable).set({ resellerCode: resellerCodeFor(reseller!.id) }).where(eq(resellersTable.id, reseller!.id));
    idsByEmail.set(person.email, reseller!.id);
  }

  const products = await db.select().from(productsTable).where(eq(productsTable.size, "50ml"));
  const settings = await getSettings();
  for (const person of people) {
    if (!person.bottles) continue;
    const resellerId = idsByEmail.get(person.email)!;
    const [reseller] = await db.select().from(resellersTable).where(eq(resellersTable.id, resellerId));
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, reseller!.userId));
    // Mixed fragrances, 20 bottles total.
    const items = [0, 1, 2, 3].map((i) => ({ productId: products[(resellerId + i) % products.length]!.id, quantity: person.bottles / 4 }));
    const result = await createOrder(
      {
        mode: "reseller",
        items,
        customer: { firstName: person.first, surname: person.last, email: person.email, mobile: user!.mobile ?? "0820000000" },
        address: DEMO_ADDRESS,
        paymentMethod: "eft",
      },
      { user: user!, reseller: reseller! },
    );
    await markOrderPaid(result.orderId, "seed");
  }

  // Retail customer purchase through Nomdade's referral link.
  const [nomdade] = await db.select().from(resellersTable).where(eq(resellersTable.id, idsByEmail.get("teamleader@masmila.co.za")!));
  const [customer] = await db.select().from(usersTable).where(eq(usersTable.email, "customer@masmila.co.za"));
  const retail = await createOrder(
    {
      mode: "retail",
      items: [{ productId: products[0]!.id, quantity: 2 }],
      customer: { firstName: "Palesa", surname: "Mokoena", email: "customer@masmila.co.za", mobile: "0820000001" },
      address: { ...DEMO_ADDRESS, line1: "44 Vilakazi Street", suburb: "Orlando West", city: "Soweto", postalCode: "1804" },
      paymentMethod: "eft",
      referralCode: nomdade!.referralCode,
      attributionSource: "link",
    },
    { user: customer!, reseller: null },
  );
  await markOrderPaid(retail.orderId, "seed");

  await db.insert(resellerApplicationsTable).values({
    applicationId: "APP-DEMO0001",
    firstName: "Zodwa",
    surname: "Khumalo",
    mobile: "0831234567",
    email: "zodwa.applicant@example.com",
    province: "KwaZulu-Natal",
    city: "Durban",
    contactMethod: "WhatsApp",
    heardAbout: "Friend or reseller",
    referringCode: nomdade!.referralCode,
    termsAccepted: true,
    privacyAccepted: true,
    resellerTermsAccepted: true,
  }).onConflictDoNothing();
  await db.insert(enquiriesTable).values({
    kind: "corporate",
    companyName: "Ubuntu Events (Pty) Ltd",
    contactPerson: "Lebo Nkosi",
    email: "lebo@ubuntu-events.example",
    phone: "0115550123",
    quantity: 120,
    productPreference: "Mixed 50ml, mostly Velvet Bloom and After Dark",
    requiredDate: "2026-11-20",
    deliveryLocation: "Sandton, Johannesburg",
    brandingRequirements: "Gift boxes with company logo sleeve",
    message: "Year-end client gifts.",
  });
  logger.info({ resellers: people.length, openingOrder: settings.openingOrder }, "Demo network seeded");
}

import { db, compensationSettingsTable, type CompensationSettings } from "@workspace/db";
import { eq } from "drizzle-orm";

export type Settings = CompensationSettings;

/** The single settings row; created with schema defaults on first use. */
export async function getSettings(): Promise<Settings> {
  const [row] = await db
    .select()
    .from(compensationSettingsTable)
    .where(eq(compensationSettingsTable.id, 1));
  if (row) return row;
  await db.insert(compensationSettingsTable).values({ id: 1 }).onConflictDoNothing();
  const [created] = await db
    .select()
    .from(compensationSettingsTable)
    .where(eq(compensationSettingsTable.id, 1));
  return created!;
}

export async function updateSettings(patch: Partial<Omit<Settings, "id" | "updatedAt">>) {
  await getSettings();
  const [row] = await db
    .update(compensationSettingsTable)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(compensationSettingsTable.id, 1))
    .returning();
  return row!;
}

/** "50:5,100:10" → [{ minBottles: 50, percent: 5 }, { minBottles: 100, percent: 10 }] */
export function parseBulkTiers(value: string) {
  return value
    .split(",")
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const [min, pct] = pair.split(":");
      return { minBottles: Number(min), percent: Number(pct) };
    })
    .filter((t) => Number.isFinite(t.minBottles) && Number.isFinite(t.percent) && t.percent > 0 && t.percent < 100)
    .sort((a, b) => a.minBottles - b.minBottles);
}

/** Bulk discount (%) for a reseller stock order of `bottles`, from the admin-configured tiers. */
export function bulkDiscountFor(bottles: number, settings: Pick<Settings, "bulkDiscountTiers">) {
  return parseBulkTiers(settings.bulkDiscountTiers).reduce((pct, t) => (bottles >= t.minBottles ? t.percent : pct), 0);
}

export function shippingFor(subtotal: number, settings: Settings): number {
  return subtotal >= settings.freeShippingThreshold ? 0 : settings.shippingFlatRate;
}

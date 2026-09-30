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

export function shippingFor(subtotal: number, settings: Settings): number {
  return subtotal >= settings.freeShippingThreshold ? 0 : settings.shippingFlatRate;
}

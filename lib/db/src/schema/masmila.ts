import { createInsertSchema } from "drizzle-zod";
import {
  boolean,
  date,
  integer,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { z } from "zod/v4";

export const resellerApplicationsTable = pgTable("reseller_applications", {
  id: serial("id").primaryKey(),
  applicationId: text("application_id").notNull().unique(),
  firstName: text("first_name").notNull(),
  surname: text("surname").notNull(),
  mobile: text("mobile").notNull(),
  email: text("email").notNull(),
  province: text("province").notNull(),
  city: text("city").notNull(),
  contactMethod: text("contact_method").notNull(),
  heardAbout: text("heard_about").notNull(),
  referringCode: text("referring_code"),
  termsAccepted: boolean("terms_accepted").notNull(),
  privacyAccepted: boolean("privacy_accepted").notNull(),
  status: text("status").notNull().default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertResellerApplicationSchema = createInsertSchema(
  resellerApplicationsTable,
).omit({ id: true, createdAt: true });
export type InsertResellerApplication = z.infer<
  typeof insertResellerApplicationSchema
>;
export type ResellerApplication = typeof resellerApplicationsTable.$inferSelect;

export const resellersTable = pgTable("resellers", {
  id: serial("id").primaryKey(),
  resellerId: text("reseller_id").notNull().unique(),
  firstName: text("first_name").notNull(),
  surname: text("surname").notNull(),
  email: text("email").notNull().unique(),
  referralCode: text("referral_code").notNull().unique(),
  sponsorReferralCode: text("sponsor_referral_code"),
  rank: text("rank").notNull().default("Reseller"),
  status: text("status").notNull().default("Active"),
  personalBottles: integer("personal_bottles").notNull().default(0),
  teamBottles: integer("team_bottles").notNull().default(0),
  lastQualifiedMonth: date("last_qualified_month", { mode: "string" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertResellerSchema = createInsertSchema(resellersTable).omit({
  id: true,
  createdAt: true,
});
export type InsertReseller = z.infer<typeof insertResellerSchema>;
export type Reseller = typeof resellersTable.$inferSelect;

export const compensationSettingsTable = pgTable("compensation_settings", {
  id: integer("id").primaryKey().default(1),
  openingOrder: integer("opening_order").notNull().default(10),
  teamLeaderRate: numeric("team_leader_rate", { precision: 5, scale: 2 })
    .notNull()
    .default("5"),
  managerRate: numeric("manager_rate", { precision: 5, scale: 2 })
    .notNull()
    .default("2"),
  directorRate: numeric("director_rate", { precision: 5, scale: 2 })
    .notNull()
    .default("1"),
  personalTarget: integer("personal_target").notNull().default(20),
  teamTarget: integer("team_target").notNull().default(100),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertCompensationSettingsSchema = createInsertSchema(
  compensationSettingsTable,
).omit({ updatedAt: true });
export type InsertCompensationSettings = z.infer<
  typeof insertCompensationSettingsSchema
>;
export type CompensationSettings = typeof compensationSettingsTable.$inferSelect;

export const auditLogsTable = pgTable("audit_logs", {
  id: serial("id").primaryKey(),
  action: text("action").notNull(),
  actorId: text("actor_id"),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id"),
  metadata: text("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertAuditLogSchema = createInsertSchema(auditLogsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertAuditLog = z.infer<typeof insertAuditLogSchema>;
export type AuditLog = typeof auditLogsTable.$inferSelect;
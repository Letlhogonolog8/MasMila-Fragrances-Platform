import { Router, type IRouter } from "express";
import { timingSafeEqual } from "node:crypto";
import { db, uploadedFilesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { notFound } from "../lib/http";

/**
 * Serves admin-uploaded files at /api/files/:id/:token. The random token
 * makes links unguessable (like a Drive share link), so files such as price
 * lists are only reachable by people who were given the link in the portal.
 */
const router: IRouter = Router();

router.get("/files/:id/:token", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw notFound();
  const [file] = await db.select().from(uploadedFilesTable).where(eq(uploadedFilesTable.id, id));
  const given = Buffer.from(String(req.params.token));
  if (!file || given.length !== Buffer.byteLength(file.token) || !timingSafeEqual(given, Buffer.from(file.token))) throw notFound();
  const inline = /^image\/|^application\/pdf$|^video\//.test(file.contentType);
  res.setHeader("Content-Type", file.contentType);
  res.setHeader("Content-Disposition", `${inline ? "inline" : "attachment"}; filename="${file.name.replace(/["\\\r\n]/g, "_")}"`);
  res.setHeader("Cache-Control", "private, max-age=86400");
  // Uploaded SVGs must not run scripts when opened directly.
  res.setHeader("Content-Security-Policy", "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox");
  res.send(Buffer.from(file.data, "base64"));
});

export default router;

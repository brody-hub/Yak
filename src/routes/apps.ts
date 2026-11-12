import { and, asc, count, eq } from "drizzle-orm"
import { Router } from "express"
import { z } from "zod"

import { db } from "../db/index.js"
import { apiKeys, appUsers, apps } from "../db/schema.js"
import { newId } from "../lib/crypto.js"
import { BadRequestError, ConflictError, NotFoundError } from "../lib/errors.js"
import { getAuth, getTenantId, requireApp } from "../middleware/auth.js"
import { requireApiKeyManagement } from "../middleware/permissions.js"
import { validate } from "../middleware/validate.js"
import { recordActivity } from "../services/activity.js"

/**
 * An account's apps. Every signed-in user can list them, since the panel
 * needs the list to offer an app switcher; creating, renaming and archiving
 * is for owners and admins, the same people who can mint the app's API keys.
 */
export const appsRouter: Router = Router()

const RESERVED_SLUGS = new Set(["new", "all", "default"])

const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    /^[a-z0-9][a-z0-9-]{1,39}$/,
    "Use 2 to 40 lowercase letters, numbers, or dashes, starting with a letter or number"
  )
  .refine((value) => !RESERVED_SLUGS.has(value), "That slug is reserved")

const nameSchema = z.string().trim().min(1).max(80)

/** Turns "Shredder iOS" into "shredder-ios"; the caller can override it. */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
}

export function serializeApp(row: typeof apps.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    status: row.status,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

appsRouter.get("/", async (req, res) => {
  const tenantId = getTenantId(req)

  const rows = await db
    .select()
    .from(apps)
    .where(eq(apps.tenantId, tenantId))
    .orderBy(asc(apps.createdAt))

  res.json({ data: rows.map(serializeApp) })
})

appsRouter.post(
  "/",
  requireApiKeyManagement,
  validate({
    body: z.object({ name: nameSchema, slug: slugSchema.optional() }).strict(),
  }),
  async (req, res) => {
    const { user } = getAuth(req)
    const tenantId = getTenantId(req)
    const body = req.body as { name: string; slug?: string }
    const slug = body.slug ?? slugify(body.name)

    if (slug.length < 2 || RESERVED_SLUGS.has(slug)) {
      throw new BadRequestError("Choose a slug for this app")
    }

    const [taken] = await db
      .select({ id: apps.id })
      .from(apps)
      .where(and(eq(apps.tenantId, tenantId), eq(apps.slug, slug)))
      .limit(1)

    if (taken) {
      throw new ConflictError("An app with that slug already exists")
    }

    const [row] = await db
      .insert(apps)
      .values({
        id: newId(),
        tenantId,
        name: body.name,
        slug,
        createdByUserId: user.id,
      })
      .returning()

    await recordActivity({
      tenantId,
      userId: user.id,
      action: "created",
      section: "apps",
      summary: `Created app ${row!.name}`,
      metadata: { appId: row!.id },
      ipAddress: req.ip,
    })

    res.status(201).json({ data: serializeApp(row!) })
  }
)

appsRouter.get("/:appId", requireApp, async (req, res) => {
  const tenantId = getTenantId(req)
  const app = req.currentApp!

  const [users] = await db
    .select({ value: count() })
    .from(appUsers)
    .where(and(eq(appUsers.tenantId, tenantId), eq(appUsers.appId, app.id)))
  const [keys] = await db
    .select({ value: count() })
    .from(apiKeys)
    .where(and(eq(apiKeys.tenantId, tenantId), eq(apiKeys.appId, app.id)))

  const [row] = await db
    .select()
    .from(apps)
    .where(and(eq(apps.id, app.id), eq(apps.tenantId, tenantId)))
    .limit(1)

  if (!row) {
    throw new NotFoundError("App")
  }

  res.json({
    data: {
      ...serializeApp(row),
      userCount: Number(users?.value ?? 0),
      apiKeyCount: Number(keys?.value ?? 0),
    },
  })
})

appsRouter.patch(
  "/:appId",
  requireApiKeyManagement,
  requireApp,
  validate({ body: z.object({ name: nameSchema }).strict() }),
  async (req, res) => {
    const { user } = getAuth(req)
    const tenantId = getTenantId(req)
    const app = req.currentApp!
    const { name } = req.body as { name: string }

    const [row] = await db
      .update(apps)
      .set({ name, updatedAt: new Date() })
      .where(and(eq(apps.id, app.id), eq(apps.tenantId, tenantId)))
      .returning()

    await recordActivity({
      tenantId,
      userId: user.id,
      action: "updated",
      section: "apps",
      summary: `Renamed app ${app.name} to ${name}`,
      metadata: { appId: app.id },
      ipAddress: req.ip,
    })

    res.json({ data: serializeApp(row!) })
  }
)

/**
 * Archiving stops the app's API keys from accepting data and hides it from
 * the switcher, without deleting anything. Deleting an app and its data is
 * deliberately not offered from the panel.
 */
appsRouter.post(
  "/:appId/archive",
  requireApiKeyManagement,
  requireApp,
  async (req, res) => {
    const { user } = getAuth(req)
    const tenantId = getTenantId(req)
    const app = req.currentApp!

    const [row] = await db
      .update(apps)
      .set({
        status: "archived",
        archivedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(apps.id, app.id), eq(apps.tenantId, tenantId)))
      .returning()

    await recordActivity({
      tenantId,
      userId: user.id,
      action: "updated",
      section: "apps",
      summary: `Archived app ${app.name}`,
      metadata: { appId: app.id },
      ipAddress: req.ip,
    })

    res.json({ data: serializeApp(row!) })
  }
)

appsRouter.post(
  "/:appId/restore",
  requireApiKeyManagement,
  requireApp,
  async (req, res) => {
    const { user } = getAuth(req)
    const tenantId = getTenantId(req)
    const app = req.currentApp!

    const [row] = await db
      .update(apps)
      .set({ status: "active", archivedAt: null, updatedAt: new Date() })
      .where(and(eq(apps.id, app.id), eq(apps.tenantId, tenantId)))
      .returning()

    await recordActivity({
      tenantId,
      userId: user.id,
      action: "updated",
      section: "apps",
      summary: `Restored app ${app.name}`,
      metadata: { appId: app.id },
      ipAddress: req.ip,
    })

    res.json({ data: serializeApp(row!) })
  }
)

import { eq } from "drizzle-orm"
import { Router } from "express"
import { z } from "zod"

import { db } from "../db/index.js"
import { appSettings } from "../db/schema.js"
import { BadRequestError } from "../lib/errors.js"
import { serializeSettings } from "../lib/serializers.js"
import { getAuth, getTenantId } from "../middleware/auth.js"
import { validate } from "../middleware/validate.js"
import { recordActivity } from "../services/activity.js"
import { imageExists, isTenantObjectKey } from "../services/r2.js"
import { loadTenant } from "../services/tenants.js"

export const settingsRouter: Router = Router()

/** Reads the tenant's settings row, creating it on first access. */
export async function loadSettings(tenantId: string) {
  const [existing] = await db
    .select()
    .from(appSettings)
    .where(eq(appSettings.tenantId, tenantId))
    .limit(1)

  if (existing) {
    return existing
  }

  const tenant = await loadTenant(tenantId)

  const [created] = await db
    .insert(appSettings)
    .values({ tenantId, brandName: tenant.name })
    .onConflictDoNothing()
    .returning()

  if (created) {
    return created
  }

  // Another request won the insert race.
  const [row] = await db
    .select()
    .from(appSettings)
    .where(eq(appSettings.tenantId, tenantId))
    .limit(1)

  if (!row) {
    throw new Error("Could not initialise application settings")
  }

  return row
}

settingsRouter.get("/theme", async (req, res) => {
  const row = await loadSettings(getTenantId(req))
  res.json({ data: serializeSettings(row) })
})

settingsRouter.put(
  "/theme",
  validate({
    body: z
      .object({
        brandName: z.string().trim().min(1).max(60).optional(),
        primaryColor: z
          .string()
          .trim()
          .regex(/^#[0-9a-fA-F]{6}$/, "Use a hex colour such as #339af0")
          .optional(),
        defaultTheme: z.enum(["light", "dark", "system"]).optional(),
        logoImageId: z.string().trim().min(1).max(255).nullable().optional(),
      })
      .strict()
      .refine((value) => Object.keys(value).length > 0, {
        message: "Provide at least one field to update",
      }),
  }),
  async (req, res) => {
    const { user } = getAuth(req)
    const tenantId = getTenantId(req)
    const body = req.body as {
      brandName?: string
      primaryColor?: string
      defaultTheme?: "light" | "dark" | "system"
      logoImageId?: string | null
    }

    const current = await loadSettings(tenantId)

    // A logo must have been uploaded into this tenant's prefix. Re-sending the
    // logo already stored is allowed, which keeps logos uploaded before the
    // multi-tenant key layout working.
    if (body.logoImageId && body.logoImageId !== current.logoImageId) {
      if (!isTenantObjectKey(body.logoImageId, tenantId, "branding")) {
        throw new BadRequestError("Invalid image reference")
      }

      if (!(await imageExists(body.logoImageId))) {
        throw new BadRequestError(
          "That image was not found or was never uploaded"
        )
      }
    }

    const [row] = await db
      .update(appSettings)
      .set({ ...body, updatedByUserId: user.id, updatedAt: new Date() })
      .where(eq(appSettings.tenantId, tenantId))
      .returning()

    await recordActivity({
      tenantId,
      userId: user.id,
      action: "updated",
      section: "theme",
      summary: `Updated ${Object.keys(body).join(", ")}`,
      ipAddress: req.ip,
    })

    res.json({ data: row ? serializeSettings(row) : null })
  }
)

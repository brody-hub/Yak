import { eq } from "drizzle-orm"
import { Router } from "express"
import { z } from "zod"

import { db } from "../db/index.js"
import { appSettings } from "../db/schema.js"
import { env } from "../env.js"
import { BadRequestError } from "../lib/errors.js"
import { serializeSettings } from "../lib/serializers.js"
import { getAuth } from "../middleware/auth.js"
import { validate } from "../middleware/validate.js"
import { recordActivity } from "../services/activity.js"
import { imageExists } from "../services/images.js"

export const settingsRouter: Router = Router()

const SETTINGS_ID = "default"

/** Reads the singleton settings row, creating it on first access. */
export async function loadSettings() {
  const [existing] = await db
    .select()
    .from(appSettings)
    .where(eq(appSettings.id, SETTINGS_ID))
    .limit(1)

  if (existing) {
    return existing
  }

  const [created] = await db
    .insert(appSettings)
    .values({ id: SETTINGS_ID, brandName: env.TENANT_NAME })
    .onConflictDoNothing()
    .returning()

  if (created) {
    return created
  }

  // Another request won the insert race.
  const [row] = await db
    .select()
    .from(appSettings)
    .where(eq(appSettings.id, SETTINGS_ID))
    .limit(1)

  if (!row) {
    throw new Error("Could not initialise application settings")
  }

  return row
}

settingsRouter.get("/theme", async (_req, res) => {
  const row = await loadSettings()
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
        logoImageId: z.string().trim().min(1).max(120).nullable().optional(),
      })
      .strict()
      .refine((value) => Object.keys(value).length > 0, {
        message: "Provide at least one field to update",
      }),
  }),
  async (req, res) => {
    const { user } = getAuth(req)
    const body = req.body as {
      brandName?: string
      primaryColor?: string
      defaultTheme?: "light" | "dark" | "system"
      logoImageId?: string | null
    }

    await loadSettings()

    if (body.logoImageId && !(await imageExists(body.logoImageId))) {
      throw new BadRequestError("That image was not found or was never uploaded")
    }

    const [row] = await db
      .update(appSettings)
      .set({ ...body, updatedByUserId: user.id, updatedAt: new Date() })
      .where(eq(appSettings.id, SETTINGS_ID))
      .returning()

    await recordActivity({
      userId: user.id,
      action: "updated",
      section: "theme",
      summary: `Updated ${Object.keys(body).join(", ")}`,
      ipAddress: req.ip,
    })

    res.json({ data: row ? serializeSettings(row) : null })
  }
)

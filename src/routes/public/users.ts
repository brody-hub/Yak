import { eq } from "drizzle-orm"
import { Router } from "express"
import { z } from "zod"

import { db } from "../../db/index.js"
import { appUsers } from "../../db/schema.js"
import { newId } from "../../lib/crypto.js"
import { NotFoundError } from "../../lib/errors.js"
import { serializeAppUser } from "../../lib/serializers.js"
import { requireApiKey } from "../../middleware/api-key.js"
import { ingestLimiter } from "../../middleware/rate-limit.js"
import { validate } from "../../middleware/validate.js"
import { fireDiscordTrigger } from "../../services/discord.js"

export const publicUsersRouter: Router = Router()

const planSchema = z.enum(["free", "plus", "pro"])
const billingPeriodSchema = z.enum(["none", "monthly", "annual"])
const statusSchema = z.enum(["active", "trialing", "churned"])

/**
 * Upserts an end user.
 *
 * Idempotent on `externalId` so the integrating app can call this on every
 * sign-in without creating duplicates. Fires the `new_user` Discord trigger
 * only on genuine first insert.
 */
publicUsersRouter.put(
  "/",
  requireApiKey("users:write"),
  ingestLimiter,
  validate({
    body: z
      .object({
        externalId: z.string().trim().min(1).max(120),
        name: z.string().trim().min(1).max(120),
        email: z.string().trim().toLowerCase().email(),
        avatarUrl: z.string().trim().url().max(500).nullable().optional(),
        plan: planSchema.default("free"),
        billingPeriod: billingPeriodSchema.default("none"),
        platform: z.enum(["ios", "android", "web"]).default("web"),
        status: statusSchema.default("active"),
        renewsAt: z.coerce.date().nullable().optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      })
      .strict(),
  }),
  async (req, res) => {
    const body = req.body as {
      externalId: string
      name: string
      email: string
      avatarUrl?: string | null
      plan: z.infer<typeof planSchema>
      billingPeriod: z.infer<typeof billingPeriodSchema>
      platform: "ios" | "android" | "web"
      status: z.infer<typeof statusSchema>
      renewsAt?: Date | null
      metadata?: Record<string, unknown>
    }

    const [existing] = await db
      .select({ id: appUsers.id, plan: appUsers.plan, status: appUsers.status })
      .from(appUsers)
      .where(eq(appUsers.externalId, body.externalId))
      .limit(1)

    const values = {
      name: body.name,
      email: body.email,
      avatarUrl: body.avatarUrl ?? null,
      plan: body.plan,
      billingPeriod: body.billingPeriod,
      platform: body.platform,
      status: body.status,
      renewsAt: body.renewsAt ?? null,
      metadata: body.metadata ?? null,
      updatedAt: new Date(),
    }

    const [row] = await db
      .insert(appUsers)
      .values({ id: newId(), externalId: body.externalId, ...values })
      .onConflictDoUpdate({ target: appUsers.externalId, set: values })
      .returning()

    if (!row) {
      throw new NotFoundError("User")
    }

    if (!existing) {
      void fireDiscordTrigger("new_user", {
        title: "New user",
        description: `${row.name} joined`,
        fields: [
          { name: "Email", value: row.email, inline: true },
          { name: "Platform", value: row.platform, inline: true },
          { name: "Plan", value: row.plan, inline: true },
        ],
      })
    }

    // A paid plan the user did not previously hold is a new subscription.
    const startedSubscription =
      body.plan !== "free" && (!existing || existing.plan === "free")

    if (startedSubscription) {
      void fireDiscordTrigger("new_subscription", {
        title: "New subscription",
        description: `${row.name} started ${row.plan}`,
        fields: [
          { name: "Plan", value: row.plan, inline: true },
          { name: "Billing", value: row.billingPeriod, inline: true },
          { name: "Status", value: row.status, inline: true },
        ],
      })
    }

    res.status(existing ? 200 : 201).json({ data: serializeAppUser(row) })
  }
)

publicUsersRouter.get(
  "/:externalId",
  requireApiKey("users:write"),
  ingestLimiter,
  validate({ params: z.object({ externalId: z.string().min(1).max(120) }) }),
  async (req, res) => {
    const [row] = await db
      .select()
      .from(appUsers)
      .where(eq(appUsers.externalId, req.params.externalId as string))
      .limit(1)

    if (!row) {
      throw new NotFoundError("User")
    }

    res.json({ data: serializeAppUser(row) })
  }
)

import { and, eq, inArray, isNull, or } from "drizzle-orm"
import { Router } from "express"
import { z } from "zod"

import { db } from "../../db/index.js"
import {
  analyticsEvents,
  appUsers,
  reports,
  tickets,
} from "../../db/schema.js"
import { newId } from "../../lib/crypto.js"
import { NotFoundError } from "../../lib/errors.js"
import { serializeAppUser } from "../../lib/serializers.js"
import { logger } from "../../logger.js"
import { getApiKey, requireApiKey } from "../../middleware/api-key.js"
import { ingestLimiter } from "../../middleware/rate-limit.js"
import { validate } from "../../middleware/validate.js"
import { fireDiscordTrigger } from "../../services/discord.js"

export const publicUsersRouter: Router = Router()

/**
 * Plan names belong to the integrating app, so any short name is accepted.
 * Lowercased so `Premium` and `premium` count as one plan. `free` is the one
 * reserved name: it means the user is not paying.
 */
const planSchema = z.string().trim().toLowerCase().min(1).max(60)
const billingPeriodSchema = z.enum(["none", "monthly", "annual"])
const statusSchema = z.enum(["active", "trialing", "churned"])
const platformSchema = z.enum(["ios", "android", "web"])

/** An empty string means "no value", which apps often send for a blank field. */
const blankToNull = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? null : value

const MAX_CLOCK_SKEW_MS = 24 * 60 * 60 * 1000

/**
 * Upserts an end user.
 *
 * Idempotent on `externalId` so the integrating app can call this on every
 * sign-in without creating duplicates. The body replaces the stored record, so
 * a field left out goes back to its default.
 *
 * Fires the `new_user` Discord trigger only on genuine first insert, and not
 * at all when the app passes `notify: false` (an existing account being synced
 * for the first time is not a new user).
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
        email: z.preprocess(
          blankToNull,
          z.string().trim().toLowerCase().email().nullable().optional()
        ),
        avatarUrl: z.string().trim().url().max(500).nullable().optional(),
        plan: planSchema.default("free"),
        billingPeriod: billingPeriodSchema.default("none"),
        platform: platformSchema.nullable().optional(),
        status: statusSchema.default("active"),
        renewsAt: z.coerce.date().nullable().optional(),
        // When the account was created in the app. Keeps "new in window"
        // honest for accounts that existed before the integration.
        createdAt: z.coerce
          .date()
          .refine(
            (value) => value.getTime() <= Date.now() + MAX_CLOCK_SKEW_MS,
            "createdAt cannot be in the future"
          )
          .optional(),
        notify: z.boolean().default(true),
        metadata: z.record(z.string(), z.unknown()).optional(),
      })
      .strict(),
  }),
  async (req, res) => {
    const body = req.body as {
      externalId: string
      name: string
      email?: string | null
      avatarUrl?: string | null
      plan: string
      billingPeriod: z.infer<typeof billingPeriodSchema>
      platform?: z.infer<typeof platformSchema> | null
      status: z.infer<typeof statusSchema>
      renewsAt?: Date | null
      createdAt?: Date
      notify: boolean
      metadata?: Record<string, unknown>
    }

    const [existing] = await db
      .select({ id: appUsers.id, plan: appUsers.plan, status: appUsers.status })
      .from(appUsers)
      .where(eq(appUsers.externalId, body.externalId))
      .limit(1)

    const values = {
      name: body.name,
      email: body.email ?? null,
      avatarUrl: body.avatarUrl ?? null,
      plan: body.plan,
      billingPeriod: body.billingPeriod,
      platform: body.platform ?? null,
      status: body.status,
      renewsAt: body.renewsAt ?? null,
      metadata: body.metadata ?? null,
      ...(body.createdAt ? { createdAt: body.createdAt } : {}),
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

    if (!existing && body.notify) {
      void fireDiscordTrigger("new_user", {
        title: "New user",
        description: `${row.name} joined`,
        fields: [
          { name: "Email", value: row.email ?? "Not provided", inline: true },
          { name: "Platform", value: row.platform ?? "Unknown", inline: true },
          { name: "Plan", value: row.plan, inline: true },
        ],
      })
    }

    // A paid plan the user did not previously hold is a new subscription.
    const startedSubscription =
      body.plan !== "free" && (!existing || existing.plan === "free")

    if (startedSubscription && body.notify) {
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

/**
 * Erases an end user, for when they delete their account in the app.
 *
 * Removes everything held about the person: the user record, their analytics
 * events, and their support reports with the whole conversation. Succeeds even
 * when no user record exists, because events and reports can be sent for
 * someone who was never synced, and so a retried delete is harmless.
 */
publicUsersRouter.delete(
  "/:externalId",
  requireApiKey("users:write"),
  ingestLimiter,
  validate({
    params: z.object({ externalId: z.string().trim().min(1).max(120) }),
  }),
  async (req, res) => {
    const apiKey = getApiKey(req)
    const externalId = req.params.externalId as string

    const deleted = await db.transaction(async (tx) => {
      const [user] = await tx
        .delete(appUsers)
        .where(eq(appUsers.externalId, externalId))
        .returning({ email: appUsers.email })

      const events = await tx
        .delete(analyticsEvents)
        .where(eq(analyticsEvents.externalUserId, externalId))

      // Reports filed without a user id are matched on the address instead.
      // Ones carrying a different id belong to someone else sharing it.
      const removedReports = await tx
        .delete(reports)
        .where(
          or(
            eq(reports.externalUserId, externalId),
            user?.email
              ? and(
                  isNull(reports.externalUserId),
                  eq(reports.reporterEmail, user.email)
                )
              : undefined
          )
        )
        .returning({ id: reports.id })

      if (removedReports.length > 0) {
        // Escalated tickets are the team's own work and stay, minus the link.
        await tx
          .update(tickets)
          .set({ sourceReportId: null })
          .where(
            inArray(
              tickets.sourceReportId,
              removedReports.map((report) => report.id)
            )
          )
      }

      return {
        user: Boolean(user),
        events: events.rowCount ?? 0,
        reports: removedReports.length,
      }
    })

    logger.info(
      { apiKeyId: apiKey.id, ...deleted },
      "Erased an app user on request"
    )

    res.json({ data: { deleted } })
  }
)

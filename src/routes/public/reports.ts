import { and, asc, desc, eq } from "drizzle-orm"
import { Router } from "express"
import { z } from "zod"

import { db } from "../../db/index.js"
import { reportMessages, reports } from "../../db/schema.js"
import { generatePublicToken, newId } from "../../lib/crypto.js"
import { BadRequestError, NotFoundError } from "../../lib/errors.js"
import { serializeReportForApi } from "../../lib/serializers.js"
import { getApiKey, requireApiKey } from "../../middleware/api-key.js"
import { ingestLimiter } from "../../middleware/rate-limit.js"
import { validate, validatedQuery } from "../../middleware/validate.js"
import { fireDiscordTrigger } from "../../services/discord.js"
import { dispatchWebhookEvent } from "../../services/webhooks.js"

export const publicReportsRouter: Router = Router()

const tokenParamSchema = z.object({ token: z.string().min(1).max(64) })

const REPORT_TYPE_LABELS = {
  bug: "Bug",
  suggestion: "Suggestion",
  support: "Support request",
  report: "User report",
} as const

/**
 * Creates a report from the integrating application.
 *
 * Returns a `token` the app can store against the submission to poll status or
 * append messages later without needing a read-scoped key.
 */
publicReportsRouter.post(
  "/",
  requireApiKey("reports:write"),
  ingestLimiter,
  validate({
    body: z
      .object({
        type: z.enum(["bug", "suggestion", "support", "report"]),
        subject: z.string().trim().min(1).max(200),
        body: z.string().trim().min(1).max(10_000),
        priority: z.enum(["urgent", "high", "medium", "low"]).default("medium"),
        reporter: z.object({
          name: z.string().trim().min(1).max(120),
          email: z.string().trim().toLowerCase().email(),
          externalUserId: z.string().trim().max(120).optional(),
        }),
        platform: z.enum(["ios", "android", "web"]).default("web"),
        appVersion: z.string().trim().max(40).optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      })
      .strict(),
  }),
  async (req, res) => {
    const apiKey = getApiKey(req)
    const body = req.body as {
      type: "bug" | "suggestion" | "support" | "report"
      subject: string
      body: string
      priority: "urgent" | "high" | "medium" | "low"
      reporter: { name: string; email: string; externalUserId?: string }
      platform: "ios" | "android" | "web"
      appVersion?: string
      metadata?: Record<string, unknown>
    }

    const row = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(reports)
        .values({
          id: newId(),
          type: body.type,
          status: "open",
          priority: body.priority,
          subject: body.subject,
          body: body.body,
          reporterName: body.reporter.name,
          reporterEmail: body.reporter.email,
          externalUserId: body.reporter.externalUserId ?? null,
          platform: body.platform,
          appVersion: body.appVersion ?? null,
          metadata: body.metadata ?? null,
          source: "api",
          apiKeyId: apiKey.id,
          publicToken: generatePublicToken(),
        })
        .returning()

      if (!created) {
        throw new BadRequestError("Could not create report")
      }

      // The opening message mirrors the body so the inbox renders a single
      // continuous conversation.
      await tx.insert(reportMessages).values({
        id: newId(),
        reportId: created.id,
        authorType: "user",
        authorName: body.reporter.name,
        body: body.body,
      })

      return created
    })

    const messages = await db
      .select()
      .from(reportMessages)
      .where(eq(reportMessages.reportId, row.id))

    void fireDiscordTrigger("new_support", {
      title: `${REPORT_TYPE_LABELS[row.type]} #${row.number}`,
      description: row.subject,
      fields: [
        { name: "From", value: `${row.reporterName} (${row.reporterEmail})` },
        { name: "Priority", value: row.priority, inline: true },
        { name: "Platform", value: row.platform, inline: true },
      ],
    })

    void dispatchWebhookEvent("report.created", {
      report: {
        id: row.id,
        number: row.number,
        type: row.type,
        status: row.status,
        priority: row.priority,
        subject: row.subject,
      },
    })

    res.status(201).json({ data: serializeReportForApi(row, messages) })
  }
)

/** Status lookup by the token returned at creation time. */
publicReportsRouter.get(
  "/:token",
  requireApiKey("reports:read"),
  ingestLimiter,
  validate({ params: tokenParamSchema }),
  async (req, res) => {
    const [row] = await db
      .select()
      .from(reports)
      .where(eq(reports.publicToken, req.params.token as string))
      .limit(1)

    if (!row) {
      throw new NotFoundError("Report")
    }

    const messages = await db
      .select()
      .from(reportMessages)
      .where(eq(reportMessages.reportId, row.id))
      .orderBy(asc(reportMessages.createdAt))

    res.json({ data: serializeReportForApi(row, messages) })
  }
)

/** Lets the reporter continue the conversation from inside the application. */
publicReportsRouter.post(
  "/:token/messages",
  requireApiKey("reports:write"),
  ingestLimiter,
  validate({
    params: tokenParamSchema,
    body: z
      .object({ body: z.string().trim().min(1).max(10_000) })
      .strict(),
  }),
  async (req, res) => {
    const { body } = req.body as { body: string }

    const [row] = await db
      .select()
      .from(reports)
      .where(eq(reports.publicToken, req.params.token as string))
      .limit(1)

    if (!row) {
      throw new NotFoundError("Report")
    }

    if (row.status === "closed") {
      throw new BadRequestError("This report is closed")
    }

    const updated = await db.transaction(async (tx) => {
      await tx.insert(reportMessages).values({
        id: newId(),
        reportId: row.id,
        authorType: "user",
        authorName: row.reporterName,
        body,
      })

      // A reply from the reporter means the ball is back with the team.
      const [next] = await tx
        .update(reports)
        .set({
          status: row.status === "waiting" ? "open" : row.status,
          updatedAt: new Date(),
        })
        .where(eq(reports.id, row.id))
        .returning()

      return next
    })

    if (!updated) {
      throw new NotFoundError("Report")
    }

    const messages = await db
      .select()
      .from(reportMessages)
      .where(eq(reportMessages.reportId, updated.id))
      .orderBy(asc(reportMessages.createdAt))

    void dispatchWebhookEvent("report.replied", {
      report: { id: updated.id, number: updated.number, status: updated.status },
      message: { author: "user", authorName: updated.reporterName, body },
    })

    res.status(201).json({ data: serializeReportForApi(updated, messages) })
  }
)

/** Every report belonging to one end user, for an in-app support history view. */
publicReportsRouter.get(
  "/",
  requireApiKey("reports:read"),
  ingestLimiter,
  validate({
    query: z
      .object({
        email: z.string().trim().toLowerCase().email().optional(),
        externalUserId: z.string().trim().max(120).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(25),
      })
      .refine((value) => value.email ?? value.externalUserId, {
        message: "Provide either email or externalUserId",
      }),
  }),
  async (req, res) => {
    const query = validatedQuery<{
      email?: string
      externalUserId?: string
      limit: number
    }>(req)

    const conditions = [
      query.email ? eq(reports.reporterEmail, query.email) : undefined,
      query.externalUserId
        ? eq(reports.externalUserId, query.externalUserId)
        : undefined,
    ].filter(Boolean)

    const rows = await db
      .select()
      .from(reports)
      .where(and(...conditions))
      .orderBy(desc(reports.updatedAt))
      .limit(query.limit)

    res.json({ data: rows.map((row) => serializeReportForApi(row)) })
  }
)

import { and, asc, desc, eq } from "drizzle-orm"
import { Router, type Request } from "express"
import { z } from "zod"

import { db } from "../../db/index.js"
import { reportMessages, reports } from "../../db/schema.js"
import { generatePublicToken, newId } from "../../lib/crypto.js"
import { BadRequestError, NotFoundError } from "../../lib/errors.js"
import { serializeReportForApi } from "../../lib/serializers.js"
import { getApiKey, requireApiKey } from "../../middleware/api-key.js"
import { getScope } from "../../middleware/auth.js"
import { ingestLimiter } from "../../middleware/rate-limit.js"
import { validate, validatedQuery } from "../../middleware/validate.js"
import { fireDiscordTrigger } from "../../services/discord.js"
import { loadApp, nextReportNumber } from "../../services/tenants.js"
import { dispatchWebhookEvent } from "../../services/webhooks.js"

/** The key's tenant and app, which every query here is confined to. */
type Scope = { tenantId: string; appId: string }

export const publicReportsRouter: Router = Router()

const tokenParamSchema = z.object({ token: z.string().min(1).max(64) })

/** An empty string means "no value", which apps often send for a blank field. */
const blankToNull = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? null : value

const IDEMPOTENCY_KEY_MAX = 200
/** Postgres unique violation. */
const UNIQUE_VIOLATION = "23505"

function readIdempotencyKey(req: Request): string | null {
  const key = req.get("idempotency-key")?.trim()

  if (!key) {
    return null
  }

  if (key.length > IDEMPOTENCY_KEY_MAX) {
    throw new BadRequestError(
      `Idempotency-Key must be at most ${IDEMPOTENCY_KEY_MAX} characters`
    )
  }

  return key
}

/** The driver error sits on `cause` when the query builder wraps it. */
function isUniqueViolation(error: unknown): boolean {
  const candidate = error as { code?: string; cause?: { code?: string } } | null

  return (
    candidate?.code === UNIQUE_VIOLATION ||
    candidate?.cause?.code === UNIQUE_VIOLATION
  )
}

async function findByIdempotencyKey(scope: Scope, key: string) {
  const [row] = await db
    .select()
    .from(reports)
    .where(
      and(
        eq(reports.tenantId, scope.tenantId),
        eq(reports.appId, scope.appId),
        eq(reports.idempotencyKey, key)
      )
    )
    .limit(1)

  if (!row) {
    return null
  }

  return serializeReportForApi(row, await loadMessages(scope, row.id))
}

async function loadMessages(scope: Scope, reportId: string) {
  return db
    .select()
    .from(reportMessages)
    .where(
      and(
        eq(reportMessages.tenantId, scope.tenantId),
        eq(reportMessages.appId, scope.appId),
        eq(reportMessages.reportId, reportId)
      )
    )
    .orderBy(asc(reportMessages.createdAt))
}

/**
 * Looks a report up by its public token. The token is random, but the lookup
 * is still confined to the calling key's app so one key can never read a
 * report that belongs to another customer, or to another of their apps.
 */
async function findByToken(scope: Scope, token: string) {
  const [row] = await db
    .select()
    .from(reports)
    .where(
      and(
        eq(reports.tenantId, scope.tenantId),
        eq(reports.appId, scope.appId),
        eq(reports.publicToken, token)
      )
    )
    .limit(1)

  if (!row) {
    throw new NotFoundError("Report")
  }

  return row
}

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
 *
 * An `Idempotency-Key` header makes the call safe to retry: a repeat with the
 * same key returns the report the first call created, with `200` instead of
 * `201`, and does not notify anyone a second time.
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
        reporter: z
          .object({
            name: z.string().trim().min(1).max(120),
            email: z.preprocess(
              blankToNull,
              z.string().trim().toLowerCase().email().nullable().optional()
            ),
            externalUserId: z.string().trim().max(120).optional(),
          })
          // Something has to tie the report back to a person.
          .refine((value) => value.email || value.externalUserId, {
            message: "Provide reporter.email or reporter.externalUserId",
            path: ["email"],
          }),
        platform: z.enum(["ios", "android", "web"]).nullable().optional(),
        appVersion: z.string().trim().max(40).optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      })
      .strict(),
  }),
  async (req, res) => {
    const apiKey = getApiKey(req)
    const scope = getScope(req)
    const { tenantId, appId } = scope
    const body = req.body as {
      type: "bug" | "suggestion" | "support" | "report"
      subject: string
      body: string
      priority: "urgent" | "high" | "medium" | "low"
      reporter: { name: string; email?: string | null; externalUserId?: string }
      platform?: "ios" | "android" | "web" | null
      appVersion?: string
      metadata?: Record<string, unknown>
    }

    const idempotencyKey = readIdempotencyKey(req)

    if (idempotencyKey) {
      const replay = await findByIdempotencyKey(scope, idempotencyKey)

      if (replay) {
        res.status(200).json({ data: replay })
        return
      }
    }

    const createReport = () =>
      db.transaction(async (tx) => {
        const [created] = await tx
          .insert(reports)
          .values({
            id: newId(),
            tenantId,
            appId,
            number: await nextReportNumber(tx, tenantId),
            type: body.type,
            status: "open",
            priority: body.priority,
            subject: body.subject,
            body: body.body,
            reporterName: body.reporter.name,
            reporterEmail: body.reporter.email ?? null,
            externalUserId: body.reporter.externalUserId || null,
            platform: body.platform ?? null,
            appVersion: body.appVersion ?? null,
            metadata: body.metadata ?? null,
            source: "api",
            apiKeyId: apiKey.id,
            idempotencyKey,
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
          tenantId,
          appId,
          reportId: created.id,
          authorType: "user",
          authorName: body.reporter.name,
          body: body.body,
        })

        return created
      })

    let row: Awaited<ReturnType<typeof createReport>>

    try {
      row = await createReport()
    } catch (error) {
      // Two copies of the same request raced; the other one won the insert.
      const replay =
        idempotencyKey && isUniqueViolation(error)
          ? await findByIdempotencyKey(scope, idempotencyKey)
          : null

      if (!replay) {
        throw error
      }

      res.status(200).json({ data: replay })
      return
    }

    const messages = await loadMessages(scope, row.id)
    const app = await loadApp(tenantId, appId)
    const origin = { id: app.id, name: app.name }

    void fireDiscordTrigger(tenantId, "new_support", {
      title: `${REPORT_TYPE_LABELS[row.type]} #${row.number}`,
      description: row.subject,
      fields: [
        {
          name: "From",
          value: row.reporterEmail
            ? `${row.reporterName} (${row.reporterEmail})`
            : row.reporterName,
        },
        { name: "Priority", value: row.priority, inline: true },
        { name: "Platform", value: row.platform ?? "Unknown", inline: true },
      ],
      app: origin,
    })

    void dispatchWebhookEvent(
      tenantId,
      "report.created",
      {
        report: {
          id: row.id,
          number: row.number,
          type: row.type,
          status: row.status,
          priority: row.priority,
          subject: row.subject,
        },
      },
      { app: origin }
    )

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
    const scope = getScope(req)
    const row = await findByToken(scope, req.params.token as string)
    const messages = await loadMessages(scope, row.id)

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
    body: z.object({ body: z.string().trim().min(1).max(10_000) }).strict(),
  }),
  async (req, res) => {
    const { body } = req.body as { body: string }
    const scope = getScope(req)
    const { tenantId, appId } = scope
    const row = await findByToken(scope, req.params.token as string)

    if (row.status === "closed") {
      throw new BadRequestError("This report is closed")
    }

    const updated = await db.transaction(async (tx) => {
      await tx.insert(reportMessages).values({
        id: newId(),
        tenantId,
        appId,
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
        .where(
          and(
            eq(reports.tenantId, tenantId),
            eq(reports.appId, appId),
            eq(reports.id, row.id)
          )
        )
        .returning()

      return next
    })

    if (!updated) {
      throw new NotFoundError("Report")
    }

    const messages = await loadMessages(scope, updated.id)
    const app = await loadApp(tenantId, appId)

    void dispatchWebhookEvent(
      tenantId,
      "report.replied",
      {
        report: {
          id: updated.id,
          number: updated.number,
          status: updated.status,
        },
        message: { author: "user", authorName: updated.reporterName, body },
      },
      { app: { id: app.id, name: app.name } }
    )

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

    const { tenantId, appId } = getScope(req)
    const conditions = [
      eq(reports.tenantId, tenantId),
      eq(reports.appId, appId),
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

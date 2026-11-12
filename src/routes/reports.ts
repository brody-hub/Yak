import { and, asc, count, desc, eq, ilike, inArray, or, sql } from "drizzle-orm"
import { Router } from "express"
import { z } from "zod"

import { db } from "../db/index.js"
import { reportMessages, reports, user as userTable } from "../db/schema.js"
import { newId } from "../lib/crypto.js"
import { BadRequestError, NotFoundError } from "../lib/errors.js"
import { paginated, paginationSchema } from "../lib/pagination.js"
import { serializeReport } from "../lib/serializers.js"
import { getAuth, getScope, getTenantId } from "../middleware/auth.js"
import { validate, validatedQuery } from "../middleware/validate.js"
import { recordActivity } from "../services/activity.js"
import { dispatchWebhookEvent } from "../services/webhooks.js"

/** Mounted under /apps/:appId, so every query here is confined to one app. */
export const reportsRouter: Router = Router({ mergeParams: true })

type Scope = { tenantId: string; appId: string }

const idParamSchema = z.object({ id: z.string().min(1) })
const typeSchema = z.enum(["bug", "suggestion", "support", "report"])
const statusSchema = z.enum([
  "open",
  "in_progress",
  "waiting",
  "resolved",
  "closed",
])
const prioritySchema = z.enum(["urgent", "high", "medium", "low"])

const CLOSED_STATUSES = ["resolved", "closed"] as const

function inApp(scope: Scope) {
  return and(
    eq(reports.tenantId, scope.tenantId),
    eq(reports.appId, scope.appId)
  )
}

async function loadReport(scope: Scope, id: string) {
  const [row] = await db
    .select()
    .from(reports)
    .where(and(eq(reports.id, id), inApp(scope)))
    .limit(1)

  if (!row) {
    throw new NotFoundError("Report")
  }

  return row
}

async function loadMessages(scope: Scope, reportId: string) {
  return db
    .select()
    .from(reportMessages)
    .where(
      and(
        eq(reportMessages.reportId, reportId),
        eq(reportMessages.tenantId, scope.tenantId),
        eq(reportMessages.appId, scope.appId)
      )
    )
    .orderBy(asc(reportMessages.createdAt))
}

/** The app the current request is for, named for outbound payloads. */
function appOrigin(req: Parameters<typeof getScope>[0]) {
  const app = req.currentApp!
  return { id: app.id, name: app.name }
}

/** Open counts per type, used for the inbox badges. */
reportsRouter.get("/counts", async (req, res) => {
  const rows = await db
    .select({ type: reports.type, total: count() })
    .from(reports)
    .where(
      and(
        inApp(getScope(req)),
        sql`${reports.status} not in ('resolved', 'closed')`
      )
    )
    .groupBy(reports.type)

  const counts = { all: 0, bug: 0, suggestion: 0, support: 0, report: 0 }

  for (const row of rows) {
    counts[row.type] = Number(row.total)
    counts.all += Number(row.total)
  }

  res.json({ data: counts })
})

reportsRouter.get(
  "/",
  validate({
    query: paginationSchema.extend({
      type: typeSchema.optional(),
      status: statusSchema.optional(),
      priority: prioritySchema.optional(),
      assigneeId: z.string().min(1).optional(),
      unassigned: z.coerce.boolean().optional(),
      search: z.string().trim().max(200).optional(),
      // Convenience filter matching the inbox's default "open work" view.
      openOnly: z.coerce.boolean().optional(),
    }),
  }),
  async (req, res) => {
    const query = validatedQuery<{
      limit: number
      offset: number
      type?: z.infer<typeof typeSchema>
      status?: z.infer<typeof statusSchema>
      priority?: z.infer<typeof prioritySchema>
      assigneeId?: string
      unassigned?: boolean
      search?: string
      openOnly?: boolean
    }>(req)

    const scope = getScope(req)
    const conditions = [
      inApp(scope),
      query.type ? eq(reports.type, query.type) : undefined,
      query.status ? eq(reports.status, query.status) : undefined,
      query.priority ? eq(reports.priority, query.priority) : undefined,
      query.assigneeId ? eq(reports.assigneeId, query.assigneeId) : undefined,
      query.unassigned ? sql`${reports.assigneeId} is null` : undefined,
      query.openOnly
        ? sql`${reports.status} not in ('resolved', 'closed')`
        : undefined,
      query.search
        ? or(
            ilike(reports.subject, `%${query.search}%`),
            ilike(reports.body, `%${query.search}%`),
            ilike(reports.reporterName, `%${query.search}%`),
            ilike(reports.reporterEmail, `%${query.search}%`)
          )
        : undefined,
    ].filter(Boolean)

    const where = and(...conditions)

    const rows = await db
      .select()
      .from(reports)
      .where(where)
      .orderBy(desc(reports.updatedAt))
      .limit(query.limit)
      .offset(query.offset)

    const [totals] = await db
      .select({ total: count() })
      .from(reports)
      .where(where)

    // One round trip for every conversation on the page rather than N.
    const ids = rows.map((row) => row.id)
    const messages = ids.length
      ? await db
          .select()
          .from(reportMessages)
          .where(
            and(
              eq(reportMessages.tenantId, scope.tenantId),
              eq(reportMessages.appId, scope.appId),
              inArray(reportMessages.reportId, ids)
            )
          )
          .orderBy(asc(reportMessages.createdAt))
      : []

    const byReport = new Map<string, typeof messages>()

    for (const message of messages) {
      const bucket = byReport.get(message.reportId) ?? []
      bucket.push(message)
      byReport.set(message.reportId, bucket)
    }

    res.json(
      paginated(
        rows.map((row) => serializeReport(row, byReport.get(row.id) ?? [])),
        Number(totals?.total ?? 0),
        { limit: query.limit, offset: query.offset }
      )
    )
  }
)

reportsRouter.get(
  "/:id",
  validate({ params: idParamSchema }),
  async (req, res) => {
    const scope = getScope(req)
    const row = await loadReport(scope, req.params.id as string)
    const messages = await loadMessages(scope, row.id)

    res.json({ data: serializeReport(row, messages) })
  }
)

reportsRouter.patch(
  "/:id",
  validate({
    params: idParamSchema,
    body: z
      .object({
        status: statusSchema.optional(),
        priority: prioritySchema.optional(),
        assigneeId: z.string().min(1).nullable().optional(),
      })
      .strict()
      .refine((value) => Object.keys(value).length > 0, {
        message: "Provide at least one field to update",
      }),
  }),
  async (req, res) => {
    const { user } = getAuth(req)
    const scope = getScope(req)
    const tenantId = getTenantId(req)
    const existing = await loadReport(scope, req.params.id as string)
    const body = req.body as {
      status?: z.infer<typeof statusSchema>
      priority?: z.infer<typeof prioritySchema>
      assigneeId?: string | null
    }

    if (body.assigneeId) {
      const [assignee] = await db
        .select({ id: userTable.id })
        .from(userTable)
        .where(
          and(
            eq(userTable.id, body.assigneeId),
            eq(userTable.tenantId, tenantId)
          )
        )
        .limit(1)

      if (!assignee) {
        throw new BadRequestError("That assignee does not exist")
      }
    }

    const becameClosed =
      body.status !== undefined &&
      CLOSED_STATUSES.includes(body.status as (typeof CLOSED_STATUSES)[number])

    const [row] = await db
      .update(reports)
      .set({
        ...body,
        // Stamp the resolution time on the first transition into a closed
        // state, and clear it if the report is reopened.
        ...(body.status !== undefined
          ? {
              resolvedAt: becameClosed
                ? (existing.resolvedAt ?? new Date())
                : null,
            }
          : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(reports.id, existing.id), inApp(scope)))
      .returning()

    if (!row) {
      throw new NotFoundError("Report")
    }

    await recordActivity({
      tenantId,
      userId: user.id,
      action: "updated",
      section: "reports",
      summary: `Updated report #${row.number}`,
      metadata: {
        reportId: row.id,
        appId: scope.appId,
        fields: Object.keys(body),
      },
      ipAddress: req.ip,
    })

    const messages = await loadMessages(scope, row.id)
    const origin = { app: appOrigin(req) }
    const payload = {
      report: {
        id: row.id,
        number: row.number,
        type: row.type,
        status: row.status,
        priority: row.priority,
        subject: row.subject,
      },
    }

    void dispatchWebhookEvent(tenantId, "report.updated", payload, origin)

    if (body.status && body.status !== existing.status) {
      void dispatchWebhookEvent(
        tenantId,
        "report.status_changed",
        { ...payload, previousStatus: existing.status },
        origin
      )

      if (becameClosed) {
        void dispatchWebhookEvent(tenantId, "report.resolved", payload, origin)
      }
    }

    res.json({ data: serializeReport(row, messages) })
  }
)

/** Agent reply. Internal notes stay out of anything the reporter can read. */
reportsRouter.post(
  "/:id/messages",
  validate({
    params: idParamSchema,
    body: z
      .object({
        body: z.string().trim().min(1).max(10_000),
        isInternal: z.boolean().default(false),
        // Convenience so replying and moving the ticket is one request.
        status: statusSchema.optional(),
      })
      .strict(),
  }),
  async (req, res) => {
    const { user } = getAuth(req)
    const scope = getScope(req)
    const tenantId = getTenantId(req)
    const existing = await loadReport(scope, req.params.id as string)
    const body = req.body as {
      body: string
      isInternal: boolean
      status?: z.infer<typeof statusSchema>
    }

    const row = await db.transaction(async (tx) => {
      await tx.insert(reportMessages).values({
        id: newId(),
        tenantId,
        appId: scope.appId,
        reportId: existing.id,
        authorType: "agent",
        authorName: user.name,
        authorUserId: user.id,
        body: body.body,
        isInternal: body.isInternal,
      })

      const [updated] = await tx
        .update(reports)
        .set({
          ...(body.status ? { status: body.status } : {}),
          updatedAt: new Date(),
        })
        .where(and(eq(reports.id, existing.id), inApp(scope)))
        .returning()

      return updated
    })

    if (!row) {
      throw new NotFoundError("Report")
    }

    await recordActivity({
      tenantId,
      userId: user.id,
      action: "updated",
      section: "reports",
      summary: `Replied to report #${row.number}`,
      metadata: {
        reportId: row.id,
        appId: scope.appId,
        internal: body.isInternal,
      },
      ipAddress: req.ip,
    })

    if (!body.isInternal) {
      void dispatchWebhookEvent(
        tenantId,
        "report.replied",
        {
          report: { id: row.id, number: row.number, status: row.status },
          message: { author: "agent", authorName: user.name, body: body.body },
        },
        { app: appOrigin(req) }
      )
    }

    const messages = await loadMessages(scope, row.id)

    res.status(201).json({ data: serializeReport(row, messages) })
  }
)

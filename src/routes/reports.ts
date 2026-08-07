import {
  and,
  asc,
  count,
  desc,
  eq,
  ilike,
  inArray,
  or,
  sql,
} from "drizzle-orm"
import { Router } from "express"
import { z } from "zod"

import { db } from "../db/index.js"
import { reportMessages, reports } from "../db/schema.js"
import { newId } from "../lib/crypto.js"
import { NotFoundError } from "../lib/errors.js"
import { paginated, paginationSchema } from "../lib/pagination.js"
import { serializeReport } from "../lib/serializers.js"
import { getAuth } from "../middleware/auth.js"
import { validate, validatedQuery } from "../middleware/validate.js"
import { recordActivity } from "../services/activity.js"
import { dispatchWebhookEvent } from "../services/webhooks.js"

export const reportsRouter: Router = Router()

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

async function loadReport(id: string) {
  const [row] = await db
    .select()
    .from(reports)
    .where(eq(reports.id, id))
    .limit(1)

  if (!row) {
    throw new NotFoundError("Report")
  }

  return row
}

async function loadMessages(reportId: string) {
  return db
    .select()
    .from(reportMessages)
    .where(eq(reportMessages.reportId, reportId))
    .orderBy(asc(reportMessages.createdAt))
}

/** Open counts per type, used for the inbox badges. */
reportsRouter.get("/counts", async (_req, res) => {
  const rows = await db
    .select({ type: reports.type, total: count() })
    .from(reports)
    .where(sql`${reports.status} not in ('resolved', 'closed')`)
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

    const conditions = [
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

    const where = conditions.length > 0 ? and(...conditions) : undefined

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
          .where(inArray(reportMessages.reportId, ids))
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
    const row = await loadReport(req.params.id as string)
    const messages = await loadMessages(row.id)

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
    const existing = await loadReport(req.params.id as string)
    const body = req.body as {
      status?: z.infer<typeof statusSchema>
      priority?: z.infer<typeof prioritySchema>
      assigneeId?: string | null
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
          ? { resolvedAt: becameClosed ? (existing.resolvedAt ?? new Date()) : null }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(reports.id, existing.id))
      .returning()

    if (!row) {
      throw new NotFoundError("Report")
    }

    await recordActivity({
      userId: user.id,
      action: "updated",
      section: "reports",
      summary: `Updated report #${row.number}`,
      metadata: { reportId: row.id, fields: Object.keys(body) },
      ipAddress: req.ip,
    })

    const messages = await loadMessages(row.id)
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

    void dispatchWebhookEvent("report.updated", payload)

    if (body.status && body.status !== existing.status) {
      void dispatchWebhookEvent("report.status_changed", {
        ...payload,
        previousStatus: existing.status,
      })

      if (becameClosed) {
        void dispatchWebhookEvent("report.resolved", payload)
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
    const existing = await loadReport(req.params.id as string)
    const body = req.body as {
      body: string
      isInternal: boolean
      status?: z.infer<typeof statusSchema>
    }

    const row = await db.transaction(async (tx) => {
      await tx.insert(reportMessages).values({
        id: newId(),
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
        .where(eq(reports.id, existing.id))
        .returning()

      return updated
    })

    if (!row) {
      throw new NotFoundError("Report")
    }

    await recordActivity({
      userId: user.id,
      action: "updated",
      section: "reports",
      summary: `Replied to report #${row.number}`,
      metadata: { reportId: row.id, internal: body.isInternal },
      ipAddress: req.ip,
    })

    if (!body.isInternal) {
      void dispatchWebhookEvent("report.replied", {
        report: { id: row.id, number: row.number, status: row.status },
        message: { author: "agent", authorName: user.name, body: body.body },
      })
    }

    const messages = await loadMessages(row.id)

    res.status(201).json({ data: serializeReport(row, messages) })
  }
)

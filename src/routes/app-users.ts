import { and, asc, count, desc, eq, gte, ilike, isNull, or } from "drizzle-orm"
import { Router } from "express"
import { z } from "zod"

import { db } from "../db/index.js"
import { appUsers, reportMessages, reports } from "../db/schema.js"
import { NotFoundError } from "../lib/errors.js"
import { serializeAppUser, serializeReport } from "../lib/serializers.js"
import { validate, validatedQuery } from "../middleware/validate.js"

export const appUsersRouter: Router = Router()

/**
 * Search over the integrating application's end users.
 *
 * An empty query returns the most recently added users, so the page shows
 * that the sync is working before anyone types. `meta.total` is the size of
 * the whole roster; the list itself is never more than `limit` rows.
 */
appUsersRouter.get(
  "/",
  validate({
    query: z.object({
      q: z.string().trim().max(200).default(""),
      limit: z.coerce.number().int().min(1).max(50).default(20),
    }),
  }),
  async (req, res) => {
    const { q, limit } = validatedQuery<{ q: string; limit: number }>(req)

    const [roster] = await db.select({ total: count() }).from(appUsers)
    const meta = { total: Number(roster?.total ?? 0) }

    if (!q) {
      const recent = await db
        .select()
        .from(appUsers)
        .orderBy(desc(appUsers.createdAt))
        .limit(limit)

      res.json({ data: recent.map(serializeAppUser), meta })
      return
    }

    const pattern = `%${q}%`

    const rows = await db
      .select()
      .from(appUsers)
      .where(
        or(
          ilike(appUsers.name, pattern),
          ilike(appUsers.email, pattern),
          ilike(appUsers.externalId, pattern)
        )
      )
      .orderBy(asc(appUsers.name))
      .limit(limit)

    res.json({ data: rows.map(serializeAppUser), meta })
  }
)

/**
 * Roster totals for the dashboard.
 *
 * Declared before `/:externalId` so the literal path is not captured by the
 * parameterised route.
 */
appUsersRouter.get(
  "/stats",
  validate({
    query: z.object({
      days: z.coerce.number().int().min(1).max(90).default(7),
    }),
  }),
  async (req, res) => {
    const { days } = validatedQuery<{ days: number }>(req)
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

    const byStatus = await db
      .select({ status: appUsers.status, total: count() })
      .from(appUsers)
      .groupBy(appUsers.status)

    const byPlan = await db
      .select({ plan: appUsers.plan, total: count() })
      .from(appUsers)
      .groupBy(appUsers.plan)

    const [recent] = await db
      .select({ total: count() })
      .from(appUsers)
      .where(gte(appUsers.createdAt, since))

    const statusTotals = { active: 0, trialing: 0, churned: 0 }
    let total = 0

    for (const row of byStatus) {
      statusTotals[row.status] = Number(row.total)
      total += Number(row.total)
    }

    // Plan names are the integrating app's own, so the keys are whatever it
    // has sent. `free` is always present because "paid" is defined against it.
    const planTotals: Record<string, number> = { free: 0 }

    for (const row of byPlan) {
      planTotals[row.plan] = Number(row.total)
    }

    res.json({
      data: {
        windowDays: days,
        total,
        ...statusTotals,
        paid: total - (planTotals.free ?? 0),
        plans: planTotals,
        newInWindow: Number(recent?.total ?? 0),
      },
    })
  }
)

/** Profile plus the support history the detail panel renders. */
appUsersRouter.get(
  "/:externalId",
  validate({ params: z.object({ externalId: z.string().min(1) }) }),
  async (req, res) => {
    const externalId = req.params.externalId as string

    const [row] = await db
      .select()
      .from(appUsers)
      .where(eq(appUsers.externalId, externalId))
      .limit(1)

    if (!row) {
      throw new NotFoundError("User")
    }

    // Reports carrying the user's id are theirs. Ones filed without an id
    // are matched on the address, when the user has one.
    const history = await db
      .select()
      .from(reports)
      .where(
        or(
          eq(reports.externalUserId, row.externalId),
          row.email
            ? and(
                isNull(reports.externalUserId),
                eq(reports.reporterEmail, row.email)
              )
            : undefined
        )
      )
      .orderBy(desc(reports.updatedAt))
      .limit(50)

    const messagesByReport = new Map<string, (typeof reportMessages.$inferSelect)[]>()

    for (const report of history) {
      const messages = await db
        .select()
        .from(reportMessages)
        .where(eq(reportMessages.reportId, report.id))
        .orderBy(asc(reportMessages.createdAt))

      messagesByReport.set(report.id, messages)
    }

    res.json({
      data: {
        user: serializeAppUser(row),
        reports: history.map((report) =>
          serializeReport(report, messagesByReport.get(report.id) ?? [])
        ),
      },
    })
  }
)

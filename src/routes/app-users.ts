import { asc, desc, eq, ilike, or } from "drizzle-orm"
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
 * An empty query returns nothing on purpose: the panel's Users page is a
 * lookup tool, not a full directory dump.
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

    if (!q) {
      res.json({ data: [] })
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

    res.json({ data: rows.map(serializeAppUser) })
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

    const history = await db
      .select()
      .from(reports)
      .where(eq(reports.reporterEmail, row.email))
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

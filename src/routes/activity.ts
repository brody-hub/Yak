import { count, eq } from "drizzle-orm"
import { Router } from "express"
import { z } from "zod"

import { db } from "../db/index.js"
import { activityLog } from "../db/schema.js"
import { paginated, paginationSchema } from "../lib/pagination.js"
import { serializeActivity } from "../lib/serializers.js"
import { validate, validatedQuery } from "../middleware/validate.js"
import { listActivity } from "../services/activity.js"

export const activityRouter: Router = Router()

activityRouter.get(
  "/",
  validate({
    query: paginationSchema.extend({
      userId: z.string().min(1).optional(),
    }),
  }),
  async (req, res) => {
    const query = validatedQuery<{
      limit: number
      offset: number
      userId?: string
    }>(req)

    const rows = await listActivity({
      limit: query.limit,
      offset: query.offset,
      ...(query.userId ? { userId: query.userId } : {}),
    })

    const [totals] = await db
      .select({ total: count() })
      .from(activityLog)
      .where(query.userId ? eq(activityLog.userId, query.userId) : undefined)

    res.json(
      paginated(rows.map(serializeActivity), Number(totals?.total ?? 0), {
        limit: query.limit,
        offset: query.offset,
      })
    )
  }
)

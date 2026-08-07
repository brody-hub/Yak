import { and, count, countDistinct, desc, eq, gte, ilike, lt, or, sql } from "drizzle-orm"
import { Router } from "express"
import { z } from "zod"

import { db } from "../db/index.js"
import { analyticsEvents } from "../db/schema.js"
import { serializeAnalyticsEvent } from "../lib/serializers.js"
import { validate, validatedQuery } from "../middleware/validate.js"

export const analyticsRouter: Router = Router()

const windowSchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(7),
})

function windowBounds(days: number) {
  const now = new Date()
  const start = new Date(now.getTime() - days * 24 * 60 * 60 * 1000)
  const previousStart = new Date(start.getTime() - days * 24 * 60 * 60 * 1000)
  const startOfToday = new Date(now)
  startOfToday.setUTCHours(0, 0, 0, 0)

  return { now, start, previousStart, startOfToday }
}

function percentChange(current: number, previous: number): number {
  if (previous === 0) {
    return current === 0 ? 0 : 100
  }

  return Number((((current - previous) / previous) * 100).toFixed(1))
}

analyticsRouter.get(
  "/summary",
  validate({ query: windowSchema }),
  async (req, res) => {
    const { days } = validatedQuery<{ days: number }>(req)
    const { start, previousStart, startOfToday } = windowBounds(days)

    const [current] = await db
      .select({
        events: count(),
        users: countDistinct(analyticsEvents.externalUserId),
      })
      .from(analyticsEvents)
      .where(gte(analyticsEvents.occurredAt, start))

    const [previous] = await db
      .select({ events: count() })
      .from(analyticsEvents)
      .where(
        and(
          gte(analyticsEvents.occurredAt, previousStart),
          lt(analyticsEvents.occurredAt, start)
        )
      )

    const [today] = await db
      .select({ events: count() })
      .from(analyticsEvents)
      .where(gte(analyticsEvents.occurredAt, startOfToday))

    const [top] = await db
      .select({ name: analyticsEvents.name, total: count() })
      .from(analyticsEvents)
      .where(gte(analyticsEvents.occurredAt, start))
      .groupBy(analyticsEvents.name)
      .orderBy(desc(count()))
      .limit(1)

    res.json({
      data: {
        windowDays: days,
        totalEvents: Number(current?.events ?? 0),
        uniqueUsers: Number(current?.users ?? 0),
        eventsToday: Number(today?.events ?? 0),
        eventsChange: percentChange(
          Number(current?.events ?? 0),
          Number(previous?.events ?? 0)
        ),
        topEvent: top?.name ?? null,
      },
    })
  }
)

analyticsRouter.get(
  "/trend",
  validate({ query: windowSchema }),
  async (req, res) => {
    const { days } = validatedQuery<{ days: number }>(req)
    const { start } = windowBounds(days)

    const rows = await db
      .select({
        date: sql<string>`to_char(date_trunc('day', ${analyticsEvents.occurredAt}), 'YYYY-MM-DD')`,
        events: count(),
        users: countDistinct(analyticsEvents.externalUserId),
      })
      .from(analyticsEvents)
      .where(gte(analyticsEvents.occurredAt, start))
      .groupBy(sql`date_trunc('day', ${analyticsEvents.occurredAt})`)
      .orderBy(sql`date_trunc('day', ${analyticsEvents.occurredAt})`)

    // Days with no traffic still need a point so the chart keeps its shape.
    const byDate = new Map(rows.map((row) => [row.date, row]))
    const series: { date: string; events: number; users: number }[] = []

    for (let offset = days - 1; offset >= 0; offset -= 1) {
      const day = new Date(Date.now() - offset * 24 * 60 * 60 * 1000)
      const key = day.toISOString().slice(0, 10)
      const row = byDate.get(key)

      series.push({
        date: key,
        events: Number(row?.events ?? 0),
        users: Number(row?.users ?? 0),
      })
    }

    res.json({ data: series })
  }
)

analyticsRouter.get(
  "/top-events",
  validate({
    query: windowSchema.extend({
      limit: z.coerce.number().int().min(1).max(50).default(10),
    }),
  }),
  async (req, res) => {
    const { days, limit } = validatedQuery<{ days: number; limit: number }>(req)
    const { start, previousStart } = windowBounds(days)

    const current = await db
      .select({
        name: analyticsEvents.name,
        total: count(),
        users: countDistinct(analyticsEvents.externalUserId),
      })
      .from(analyticsEvents)
      .where(gte(analyticsEvents.occurredAt, start))
      .groupBy(analyticsEvents.name)
      .orderBy(desc(count()))
      .limit(limit)

    const previous = await db
      .select({ name: analyticsEvents.name, total: count() })
      .from(analyticsEvents)
      .where(
        and(
          gte(analyticsEvents.occurredAt, previousStart),
          lt(analyticsEvents.occurredAt, start)
        )
      )
      .groupBy(analyticsEvents.name)

    const previousByName = new Map(
      previous.map((row) => [row.name, Number(row.total)])
    )

    res.json({
      data: current.map((row) => ({
        name: row.name,
        count: Number(row.total),
        uniqueUsers: Number(row.users),
        change: percentChange(
          Number(row.total),
          previousByName.get(row.name) ?? 0
        ),
      })),
    })
  }
)

/** Distinct event names, for the filter dropdown in the live stream. */
analyticsRouter.get("/names", async (_req, res) => {
  const rows = await db
    .selectDistinct({ name: analyticsEvents.name })
    .from(analyticsEvents)
    .orderBy(analyticsEvents.name)
    .limit(200)

  res.json({ data: rows.map((row) => row.name) })
})

analyticsRouter.get(
  "/events",
  validate({
    query: z.object({
      limit: z.coerce.number().int().min(1).max(200).default(50),
      name: z.string().trim().max(120).optional(),
      search: z.string().trim().max(200).optional(),
      externalUserId: z.string().trim().max(120).optional(),
    }),
  }),
  async (req, res) => {
    const query = validatedQuery<{
      limit: number
      name?: string
      search?: string
      externalUserId?: string
    }>(req)

    const conditions = [
      query.name ? eq(analyticsEvents.name, query.name) : undefined,
      query.externalUserId
        ? eq(analyticsEvents.externalUserId, query.externalUserId)
        : undefined,
      query.search
        ? or(
            ilike(analyticsEvents.name, `%${query.search}%`),
            ilike(analyticsEvents.userName, `%${query.search}%`),
            ilike(analyticsEvents.externalUserId, `%${query.search}%`)
          )
        : undefined,
    ].filter(Boolean)

    const rows = await db
      .select()
      .from(analyticsEvents)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(analyticsEvents.occurredAt))
      .limit(query.limit)

    res.json({ data: rows.map(serializeAnalyticsEvent) })
  }
)

import { Router } from "express"
import { z } from "zod"

import { db } from "../../db/index.js"
import { analyticsEvents } from "../../db/schema.js"
import { newId } from "../../lib/crypto.js"
import { BadRequestError } from "../../lib/errors.js"
import { getApiKey, requireApiKey } from "../../middleware/api-key.js"
import { eventIngestLimiter } from "../../middleware/rate-limit.js"
import { validate } from "../../middleware/validate.js"

export const publicEventsRouter: Router = Router()

/** Property values stay scalar so the analytics table remains queryable. */
const propertyValueSchema = z.union([z.string().max(500), z.number(), z.boolean()])

const eventSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .regex(
      /^[a-zA-Z0-9_.:-]+$/,
      "Event names may only contain letters, numbers, and _ . : -"
    ),
  userId: z.string().trim().max(120).optional(),
  userName: z.string().trim().max(120).optional(),
  anonymousId: z.string().trim().max(120).optional(),
  sessionId: z.string().trim().max(120).optional(),
  platform: z.enum(["ios", "android", "web"]).optional(),
  appVersion: z.string().trim().max(40).optional(),
  properties: z.record(z.string().max(80), propertyValueSchema).default({}),
  // Client clock. Rejected if implausible so a bad device clock cannot poison
  // the time series.
  timestamp: z.coerce.date().optional(),
})

const MAX_BATCH = 200
const MAX_CLOCK_SKEW_MS = 24 * 60 * 60 * 1000

function resolveOccurredAt(timestamp: Date | undefined, now: Date): Date {
  if (!timestamp) {
    return now
  }

  const drift = timestamp.getTime() - now.getTime()

  // Anything more than a day in the future, or older than 30 days, is treated
  // as an unreliable client clock and clamped to receipt time.
  if (drift > MAX_CLOCK_SKEW_MS || drift < -30 * 24 * 60 * 60 * 1000) {
    return now
  }

  return timestamp
}

/**
 * Accepts a single event or a batch.
 *
 * Ingest is intentionally forgiving in shape but strict in validation: one bad
 * event in a batch fails the whole request so the client can correct and retry
 * rather than silently losing data.
 */
publicEventsRouter.post(
  "/",
  requireApiKey("events:write"),
  eventIngestLimiter,
  validate({
    body: z.union([
      eventSchema,
      z.object({ events: z.array(eventSchema).min(1).max(MAX_BATCH) }),
    ]),
  }),
  async (req, res) => {
    const apiKey = getApiKey(req)
    const payload = req.body as
      | z.infer<typeof eventSchema>
      | { events: z.infer<typeof eventSchema>[] }

    const events = "events" in payload ? payload.events : [payload]

    if (events.length === 0) {
      throw new BadRequestError("Send at least one event")
    }

    const now = new Date()

    const rows = events.map((event) => ({
      id: newId(),
      name: event.name,
      externalUserId: event.userId ?? null,
      userName: event.userName ?? null,
      anonymousId: event.anonymousId ?? null,
      sessionId: event.sessionId ?? null,
      platform: event.platform ?? null,
      appVersion: event.appVersion ?? null,
      properties: event.properties,
      apiKeyId: apiKey.id,
      occurredAt: resolveOccurredAt(event.timestamp, now),
      receivedAt: now,
    }))

    await db.insert(analyticsEvents).values(rows)

    res.status(202).json({ data: { accepted: rows.length } })
  }
)

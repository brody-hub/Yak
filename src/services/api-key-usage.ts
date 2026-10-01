import { eq } from "drizzle-orm"
import type { Request } from "express"

import { db } from "../db/index.js"
import { apiKeys } from "../db/schema.js"
import { logger } from "../logger.js"

const MAX_MESSAGE_LENGTH = 300
/** A broken integration fails in bursts; one write per burst is enough. */
const REPEAT_WINDOW_MS = 5_000

const lastRecorded = new Map<string, { message: string; at: number }>()

/**
 * `PUT /api/v1/users`, without ids or tokens from the path, which would put a
 * user identifier or a report token on the settings page.
 */
function endpointLabel(req: Request): string {
  const [path = ""] = req.originalUrl.split("?")
  const segments = path.split("/").filter(Boolean)
  const head = segments.slice(0, 3).join("/")

  return `${req.method} /${head}${segments.length > 3 ? "/…" : ""}`
}

/**
 * Remembers the most recent request a key had rejected, so the settings page
 * can show why an integration is failing instead of just "Never used".
 *
 * Best effort, like usage tracking: a write failure here must not change the
 * response the caller was already going to get.
 */
export function recordApiKeyFailure(
  apiKeyId: string,
  req: Request,
  failure: { status: number; code: string; detail?: string }
): void {
  const message = [
    `${failure.status} ${failure.code} on ${endpointLabel(req)}`,
    failure.detail,
  ]
    .filter(Boolean)
    .join(": ")
    .slice(0, MAX_MESSAGE_LENGTH)

  const previous = lastRecorded.get(apiKeyId)
  const now = Date.now()

  if (
    previous &&
    previous.message === message &&
    now - previous.at < REPEAT_WINDOW_MS
  ) {
    return
  }

  lastRecorded.set(apiKeyId, { message, at: now })

  void db
    .update(apiKeys)
    .set({ lastErrorAt: new Date(now), lastError: message })
    .where(eq(apiKeys.id, apiKeyId))
    .catch((error: unknown) => {
      logger.warn({ err: error }, "Could not record API key failure")
    })
}

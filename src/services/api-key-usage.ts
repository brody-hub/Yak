import { eq } from "drizzle-orm"
import type { Request } from "express"

import { apiKeys } from "../db/schema.js"
import { withTenantScope } from "../db/scope.js"
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
 * response the caller was already going to get. Runs in the key's own tenant
 * scope since it is called before, or after, the request has one.
 */
export function recordApiKeyFailure(
  key: { id: string; tenantId: string },
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

  const previous = lastRecorded.get(key.id)
  const now = Date.now()

  if (
    previous &&
    previous.message === message &&
    now - previous.at < REPEAT_WINDOW_MS
  ) {
    return
  }

  lastRecorded.set(key.id, { message, at: now })

  void withTenantScope(key.tenantId, (scoped) =>
    scoped
      .update(apiKeys)
      .set({ lastErrorAt: new Date(now), lastError: message })
      .where(eq(apiKeys.id, key.id))
  ).catch((error: unknown) => {
    logger.warn({ err: error }, "Could not record API key failure")
  })
}

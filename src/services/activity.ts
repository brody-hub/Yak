import { desc, eq } from "drizzle-orm"

import { db } from "../db/index.js"
import { activityLog, user as userTable } from "../db/schema.js"
import { newId } from "../lib/crypto.js"
import { logger } from "../logger.js"

type ActivityAction =
  | "signed_in"
  | "viewed"
  | "created"
  | "updated"
  | "deleted"
  | "invited"
  | "exported"

/**
 * Appends to the panel audit trail.
 *
 * Never throws: an audit write failing must not roll back or reject the action
 * the operator actually performed. Failures are logged instead.
 */
export async function recordActivity(params: {
  userId: string
  action: ActivityAction
  section: string
  summary: string
  metadata?: Record<string, unknown>
  ipAddress?: string | null
}): Promise<void> {
  try {
    await db.insert(activityLog).values({
      id: newId(),
      userId: params.userId,
      action: params.action,
      section: params.section,
      summary: params.summary,
      metadata: params.metadata ?? null,
      ipAddress: params.ipAddress ?? null,
    })
  } catch (error) {
    logger.warn({ err: error, ...params }, "Could not write activity log entry")
  }
}

export async function listActivity(params: {
  userId?: string
  limit: number
  offset: number
}) {
  const base = db
    .select({
      id: activityLog.id,
      action: activityLog.action,
      section: activityLog.section,
      summary: activityLog.summary,
      metadata: activityLog.metadata,
      createdAt: activityLog.createdAt,
      userId: activityLog.userId,
      userName: userTable.name,
      userEmail: userTable.email,
    })
    .from(activityLog)
    .innerJoin(userTable, eq(activityLog.userId, userTable.id))
    .orderBy(desc(activityLog.createdAt))
    .limit(params.limit)
    .offset(params.offset)

  return params.userId
    ? base.where(eq(activityLog.userId, params.userId))
    : base
}

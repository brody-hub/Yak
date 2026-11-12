import { and, desc, eq } from "drizzle-orm"

import { isSuperAdminRole } from "../auth/permissions.js"
import { db } from "../db/index.js"
import { env } from "../env.js"
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
  /** The tenant acted on. Null for super admin actions outside any tenant. */
  tenantId: string | null
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
      tenantId: params.tenantId,
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
  tenantId: string
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
      userRole: userTable.role,
    })
    .from(activityLog)
    .innerJoin(userTable, eq(activityLog.userId, userTable.id))
    .where(
      and(
        eq(activityLog.tenantId, params.tenantId),
        params.userId ? eq(activityLog.userId, params.userId) : undefined
      )
    )
    .orderBy(desc(activityLog.createdAt))
    .limit(params.limit)
    .offset(params.offset)

  // Yak staff acting on the account show up as "Yak support", without their
  // name or email: customers see that it happened, not who at Yak did it.
  const rows = await base

  return rows.map(({ userRole, ...row }) =>
    isSuperAdminRole(userRole)
      ? { ...row, userId: "", userName: `${env.APP_NAME} support`, userEmail: "" }
      : row
  )
}

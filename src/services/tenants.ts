import { and, eq, sql } from "drizzle-orm"

import { db } from "../db/index.js"
import { apps, tenants } from "../db/schema.js"
import { NotFoundError } from "../lib/errors.js"

type Executor = Pick<typeof db, "update" | "select">

export async function loadTenant(tenantId: string) {
  const [row] = await db
    .select()
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1)

  if (!row) {
    throw new NotFoundError("Account")
  }

  return row
}

/** One of the tenant's apps; another tenant's app id is a 404. */
export async function loadApp(tenantId: string, appId: string) {
  const [row] = await db
    .select()
    .from(apps)
    .where(and(eq(apps.id, appId), eq(apps.tenantId, tenantId)))
    .limit(1)

  if (!row) {
    throw new NotFoundError("App")
  }

  return row
}

/**
 * Hands out the tenant's next ticket number. The row lock taken by the update
 * serialises concurrent creates within one tenant, so pass the transaction
 * that inserts the ticket to keep a rolled back create from burning a number.
 */
export async function nextTicketNumber(
  tx: Executor,
  tenantId: string
): Promise<number> {
  const [row] = await tx
    .update(tenants)
    .set({ ticketSeq: sql`${tenants.ticketSeq} + 1` })
    .where(eq(tenants.id, tenantId))
    .returning({ value: tenants.ticketSeq })

  if (!row) {
    throw new NotFoundError("Account")
  }

  return row.value
}

/** Same as nextTicketNumber, for support reports. */
export async function nextReportNumber(
  tx: Executor,
  tenantId: string
): Promise<number> {
  const [row] = await tx
    .update(tenants)
    .set({ reportSeq: sql`${tenants.reportSeq} + 1` })
    .where(eq(tenants.id, tenantId))
    .returning({ value: tenants.reportSeq })

  if (!row) {
    throw new NotFoundError("Account")
  }

  return row.value
}

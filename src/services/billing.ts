import { and, eq, gte, lt, sql } from "drizzle-orm"

import { getPlan, PLANS, tierForMau } from "../billing/plans.js"
import { db } from "../db/index.js"
import { analyticsEvents, tenants } from "../db/schema.js"
import { NotFoundError } from "../lib/errors.js"

/**
 * Monthly active users, as the pricing document defines them: one unique end
 * user of the account's apps with at least one event in a calendar month
 * (UTC), added up across every app. A signed-in user counts by id; before
 * sign in, by device, so a person who signs up mid-month is counted at most
 * twice until the app starts sending their id. Test accounts and bots are not
 * yet excluded; that needs the flags the document describes.
 */
export async function countMonthlyActiveUsers(
  tenantId: string,
  monthStart: Date
): Promise<number> {
  const monthEnd = new Date(
    Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 1)
  )

  const [row] = await db
    .select({
      value: sql<number>`count(distinct coalesce(${analyticsEvents.externalUserId}, ${analyticsEvents.anonymousId}))`,
    })
    .from(analyticsEvents)
    .where(
      and(
        eq(analyticsEvents.tenantId, tenantId),
        gte(analyticsEvents.occurredAt, monthStart),
        lt(analyticsEvents.occurredAt, monthEnd)
      )
    )

  return Number(row?.value ?? 0)
}

function startOfUtcMonth(date: Date, monthsAgo = 0): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - monthsAgo, 1)
  )
}

export async function describeBilling(tenantId: string) {
  const [tenant] = await db
    .select({ plan: tenants.plan, stripeCustomerId: tenants.stripeCustomerId })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1)

  if (!tenant) {
    throw new NotFoundError("Account")
  }

  // One statement at a time: the request holds a single connection.
  const now = new Date()
  const current = await countMonthlyActiveUsers(tenantId, startOfUtcMonth(now))
  const previous = await countMonthlyActiveUsers(
    tenantId,
    startOfUtcMonth(now, 1)
  )
  const beforePrevious = await countMonthlyActiveUsers(
    tenantId,
    startOfUtcMonth(now, 2)
  )

  // Paid tiers are set by the peak of the last two full months, so one
  // weekend spike does not change the bill.
  const billableMau = Math.max(previous, beforePrevious)
  const plan = getPlan(tenant.plan)

  return {
    plan: {
      id: plan.id,
      name: plan.name,
      mauCap: plan.mauCap,
      monthlyPrice: plan.monthlyPrice,
      annualPrice: plan.annualPrice,
      adminSeats: plan.adminSeats,
      historyDays: plan.historyDays,
      eventsPerMonth: plan.eventsPerMonth,
      support: plan.support,
    },
    plans: PLANS,
    usage: {
      currentMonthMau: current,
      previousMonthMau: previous,
      billableMau,
      /** The tier the billable MAU would place the account on. */
      suggestedPlanId: tierForMau(billableMau).id,
    },
    hasPaymentMethod: Boolean(tenant.stripeCustomerId),
  }
}

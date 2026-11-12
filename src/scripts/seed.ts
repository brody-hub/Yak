import { asc, count, eq } from "drizzle-orm"

import { closeDatabase, db } from "../db/index.js"
import {
  analyticsEvents,
  apps,
  appUsers,
  reportMessages,
  reports,
  sprints,
  tenants,
  tickets,
} from "../db/schema.js"
import { withTenantScope } from "../db/scope.js"
import { generatePublicToken, newId } from "../lib/crypto.js"
import { logger } from "../logger.js"
import { nextReportNumber, nextTicketNumber } from "../services/tenants.js"

/**
 * Fills a tenant's first app with representative data so the panel has
 * something to render before a real integration is wired up. Safe to skip in
 * production.
 *
 *   npm run seed                 seeds the oldest tenant
 *   npm run seed -- <slug>       seeds the tenant with that slug
 *
 * Tenants are created from the admin console, so this never creates one. The
 * whole run happens inside the tenant's database scope, as a panel request
 * would, so row level security applies to it like to everything else.
 */

function daysAgo(days: number, hour = 12): Date {
  const date = new Date()
  date.setUTCDate(date.getUTCDate() - days)
  date.setUTCHours(hour, 0, 0, 0)
  return date
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date)
  next.setUTCDate(next.getUTCDate() + days)
  return next
}

const APP_USERS = [
  {
    name: "Maya Chen",
    email: "maya@example.com",
    plan: "pro",
    billingPeriod: "annual",
    platform: "ios",
    status: "active",
  },
  {
    name: "Noah Patel",
    email: "noah@example.com",
    plan: "pro",
    billingPeriod: "monthly",
    platform: "android",
    status: "active",
  },
  {
    name: "Sofia Alvarez",
    email: "sofia@example.com",
    plan: "plus",
    billingPeriod: "monthly",
    platform: "android",
    status: "trialing",
  },
  {
    name: "Liam Brooks",
    email: "liam@example.com",
    plan: "free",
    billingPeriod: "none",
    platform: "web",
    status: "active",
  },
  {
    name: "Ava Nguyen",
    email: "ava@example.com",
    plan: "plus",
    billingPeriod: "annual",
    platform: "ios",
    status: "active",
  },
  {
    name: "Ethan Cole",
    email: "ethan@example.com",
    plan: "free",
    billingPeriod: "none",
    platform: "web",
    status: "churned",
  },
  {
    name: "Harper Diaz",
    email: "harper@example.com",
    plan: "pro",
    billingPeriod: "monthly",
    platform: "ios",
    status: "trialing",
  },
  {
    name: "Owen Kim",
    email: "owen@example.com",
    plan: "plus",
    billingPeriod: "monthly",
    platform: "web",
    status: "active",
  },
  {
    name: "Isla Freya",
    email: "isla@example.com",
    plan: "free",
    billingPeriod: "none",
    platform: "ios",
    status: "active",
  },
  {
    name: "Jack Morgan",
    email: "jack@example.com",
    plan: "pro",
    billingPeriod: "annual",
    platform: "android",
    status: "churned",
  },
] as const

const REPORTS = [
  {
    type: "bug",
    status: "open",
    priority: "urgent",
    subject: "App crashes when opening workout history",
    body: "Every time I tap History on iOS 18, the app freezes for a second then closes. Happens on Wi-Fi and cellular.",
    reporter: "Maya Chen",
    email: "maya@example.com",
    platform: "ios",
    ageDays: 0,
  },
  {
    type: "support",
    status: "in_progress",
    priority: "high",
    subject: "Can't restore my Pro subscription",
    body: "I switched phones and Restore Purchases says nothing to restore. Receipt is under the same Apple ID.",
    reporter: "Noah Patel",
    email: "noah@example.com",
    platform: "ios",
    ageDays: 0,
    reply:
      "Thanks Noah - checking your customer ID now. Can you confirm the email on the Apple receipt?",
  },
  {
    type: "suggestion",
    status: "open",
    priority: "medium",
    subject: "Add dark mode schedule based on sunset",
    body: "Would love automatic dark mode that follows sunrise/sunset instead of only the system setting.",
    reporter: "Sofia Alvarez",
    email: "sofia@example.com",
    platform: "android",
    ageDays: 1,
  },
  {
    type: "report",
    status: "waiting",
    priority: "high",
    subject: "Reported spam in community feed",
    body: "User @shredbot99 is posting affiliate links in every comment thread.",
    reporter: "Liam Brooks",
    email: "liam@example.com",
    platform: "web",
    ageDays: 1,
    reply:
      "Thanks - we temporarily hid the posts. Can you share a couple of links if you still see them?",
  },
  {
    type: "bug",
    status: "resolved",
    priority: "medium",
    subject: "Timer keeps running after finishing a set",
    body: "Rest timer doesn't stop when I mark the set complete on Android 14.",
    reporter: "Ava Nguyen",
    email: "ava@example.com",
    platform: "android",
    ageDays: 2,
    reply:
      "Fixed in 2.14.1 - please update and let us know if it still happens.",
  },
  {
    type: "support",
    status: "open",
    priority: "low",
    subject: "How do I export my workout data?",
    body: "Looking for a CSV export of the last 90 days for my coach.",
    reporter: "Ethan Cole",
    email: "ethan@example.com",
    platform: "web",
    ageDays: 2,
  },
  {
    type: "report",
    status: "open",
    priority: "urgent",
    subject: "Harassment in DMs",
    body: "Receiving threatening messages from another user after a leaderboard comment.",
    reporter: "Owen Kim",
    email: "owen@example.com",
    platform: "ios",
    ageDays: 0,
  },
] as const

const TICKETS = [
  {
    title: "Polish dashboard KPI cards",
    description:
      "Tighten spacing and make trend badges match the primary color system.",
    status: "in_progress",
    priority: "high",
    sprint: 1,
  },
  {
    title: "Add report triage filters",
    description:
      "Allow filtering reports by status and severity in the support inbox.",
    status: "todo",
    priority: "medium",
    sprint: 1,
  },
  {
    title: "Ship theme branding upload",
    description: "Logo upload and app name should persist to the backend.",
    status: "done",
    priority: "high",
    sprint: 0,
  },
  {
    title: "Define sprint capacity view",
    description: "Show assigned ticket count per system user for the sprint.",
    status: "backlog",
    priority: "low",
    sprint: null,
  },
  {
    title: "Improve user activity log",
    description: "Group activity by day and add filter chips for action type.",
    status: "todo",
    priority: "urgent",
    sprint: 1,
  },
  {
    title: "Notification digests for assignees",
    description: "Email a daily digest when assigned tickets change status.",
    status: "backlog",
    priority: "medium",
    sprint: null,
  },
  {
    title: "Bulk permission editing",
    description: "Select multiple panel users and apply section permissions.",
    status: "todo",
    priority: "high",
    sprint: null,
  },
] as const

const EVENT_NAMES = [
  { name: "screen_viewed", weight: 40 },
  { name: "button_tapped", weight: 28 },
  { name: "paywall_shown", weight: 10 },
  { name: "search_performed", weight: 8 },
  { name: "push_opened", weight: 5 },
  { name: "onboarding_completed", weight: 4 },
  { name: "trial_started", weight: 3 },
  { name: "purchase_completed", weight: 2 },
] as const

function pickEventName(): string {
  const total = EVENT_NAMES.reduce((sum, entry) => sum + entry.weight, 0)
  let roll = Math.random() * total

  for (const entry of EVENT_NAMES) {
    roll -= entry.weight

    if (roll <= 0) {
      return entry.name
    }
  }

  return EVENT_NAMES[0].name
}

async function resolveTenant(slug: string | undefined) {
  const [row] = slug
    ? await db.select().from(tenants).where(eq(tenants.slug, slug)).limit(1)
    : await db.select().from(tenants).orderBy(asc(tenants.createdAt)).limit(1)

  if (!row) {
    throw new Error(
      slug
        ? `No tenant with slug "${slug}"`
        : "No tenants exist yet. Create one from the admin console first."
    )
  }

  return row
}

async function isEmpty(tenantId: string): Promise<boolean> {
  const [row] = await db
    .select({ total: count() })
    .from(appUsers)
    .where(eq(appUsers.tenantId, tenantId))
  return Number(row?.total ?? 0) === 0
}

/** The tenant's oldest app, created if the account somehow has none. */
async function resolveApp(tenant: { id: string; name: string; slug: string }) {
  const [existing] = await db
    .select()
    .from(apps)
    .where(eq(apps.tenantId, tenant.id))
    .orderBy(asc(apps.createdAt))
    .limit(1)

  if (existing) {
    return existing
  }

  const [created] = await db
    .insert(apps)
    .values({
      id: newId(),
      tenantId: tenant.id,
      name: tenant.name,
      slug: tenant.slug,
    })
    .returning()

  return created!
}

async function main() {
  const tenant = await resolveTenant(process.argv[2]?.trim() || undefined)

  await withTenantScope(tenant.id, () => seedTenant(tenant))
}

async function seedTenant(tenant: { id: string; name: string; slug: string }) {
  const tenantId = tenant.id

  if (!(await isEmpty(tenantId))) {
    logger.info(
      { tenant: tenant.slug },
      "Tenant already has data - skipping seed"
    )
    return
  }

  const app = await resolveApp(tenant)
  const appId = app.id

  logger.info({ tenant: tenant.slug, app: app.slug }, "Seeding demo data")

  /* App users -------------------------------------------------------------- */

  const userRows = APP_USERS.map((entry, index) => ({
    id: newId(),
    tenantId,
    appId,
    externalId: `u_${1000 + index * 137}`,
    name: entry.name,
    email: entry.email,
    plan: entry.plan,
    billingPeriod: entry.billingPeriod,
    platform: entry.platform,
    status: entry.status,
    renewsAt: entry.plan === "free" ? null : addDays(new Date(), 30 + index),
    createdAt: daysAgo(120 - index * 9),
  }))

  await db.insert(appUsers).values(userRows)

  /* Sprints and tickets ---------------------------------------------------- */

  const sprintStart = daysAgo(9, 0)
  const sprintRows = [
    {
      id: newId(),
      tenantId,
      name: "Sprint 12",
      durationWeeks: 2,
      startDate: sprintStart,
      endDate: addDays(sprintStart, 13),
    },
    {
      id: newId(),
      tenantId,
      name: "Sprint 13",
      durationWeeks: 1,
      startDate: addDays(sprintStart, 14),
      endDate: addDays(sprintStart, 20),
    },
  ]

  await db.insert(sprints).values(sprintRows)

  // One at a time so each ticket draws the tenant's next number.
  for (const [index, entry] of TICKETS.entries()) {
    await db.transaction(async (tx) => {
      await tx.insert(tickets).values({
        id: newId(),
        tenantId,
        number: await nextTicketNumber(tx, tenantId),
        title: entry.title,
        description: entry.description,
        status: entry.status,
        priority: entry.priority,
        sprintId: entry.sprint === null ? null : sprintRows[entry.sprint]!.id,
        createdAt: daysAgo(7 - index, 9),
        updatedAt: daysAgo(Math.max(0, 5 - index), 14),
      })
    })
  }

  /* Reports ---------------------------------------------------------------- */

  for (const entry of REPORTS) {
    const createdAt = daysAgo(entry.ageDays, 10)

    const report = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(reports)
        .values({
          id: newId(),
          tenantId,
          appId,
          number: await nextReportNumber(tx, tenantId),
          type: entry.type,
          status: entry.status,
          priority: entry.priority,
          subject: entry.subject,
          body: entry.body,
          reporterName: entry.reporter,
          reporterEmail: entry.email,
          platform: entry.platform,
          source: "api",
          publicToken: generatePublicToken(),
          createdAt,
          updatedAt: createdAt,
          resolvedAt:
            entry.status === "resolved" ? addDays(createdAt, 1) : null,
        })
        .returning()

      return created
    })

    if (!report) {
      continue
    }

    const messages: (typeof reportMessages.$inferInsert)[] = [
      {
        id: newId(),
        tenantId,
        appId,
        reportId: report.id,
        authorType: "user",
        authorName: entry.reporter,
        body: entry.body,
        createdAt,
      },
    ]

    if ("reply" in entry && entry.reply) {
      messages.push({
        id: newId(),
        tenantId,
        appId,
        reportId: report.id,
        authorType: "agent",
        authorName: "Support",
        body: entry.reply,
        createdAt: new Date(createdAt.getTime() + 3 * 60 * 60 * 1000),
      })
    }

    await db.insert(reportMessages).values(messages)
  }

  /* Analytics events ------------------------------------------------------- */

  const events: (typeof analyticsEvents.$inferInsert)[] = []

  for (let day = 13; day >= 0; day -= 1) {
    // A gentle upward trend with some noise, so the chart is not a flat line.
    const volume = Math.round(160 + (13 - day) * 12 + Math.random() * 60)

    for (let index = 0; index < volume; index += 1) {
      const actor = userRows[Math.floor(Math.random() * userRows.length)]!
      const occurredAt = new Date(
        daysAgo(day, 0).getTime() + Math.random() * 24 * 60 * 60 * 1000
      )

      events.push({
        id: newId(),
        tenantId,
        appId,
        name: pickEventName(),
        externalUserId: actor.externalId,
        userName: actor.name,
        platform: actor.platform,
        appVersion: "2.14.1",
        properties: { screen: "home", source: "seed" },
        occurredAt,
        receivedAt: occurredAt,
      })
    }
  }

  // Chunked so a single statement does not exceed the parameter limit.
  for (let index = 0; index < events.length; index += 500) {
    await db.insert(analyticsEvents).values(events.slice(index, index + 500))
  }

  logger.info(
    {
      appUsers: userRows.length,
      sprints: sprintRows.length,
      tickets: TICKETS.length,
      reports: REPORTS.length,
      events: events.length,
    },
    "Seed complete"
  )
}

main()
  .catch((error) => {
    logger.error({ err: error }, "Seed failed")
    process.exitCode = 1
  })
  .finally(async () => {
    await closeDatabase()
  })

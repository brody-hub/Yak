import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  max,
  sql,
} from "drizzle-orm"
import { Router } from "express"
import { z } from "zod"

import { env } from "../env.js"
import { SUPER_ADMIN_ROLE, USER_ROLES } from "../auth/permissions.js"
import { PLAN_IDS } from "../billing/plans.js"
import { db } from "../db/index.js"
import {
  apps,
  session as sessionTable,
  type PlanTier,
  type Tenant,
  tenants,
  user as userTable,
} from "../db/schema.js"
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "../lib/errors.js"
import { serializeSystemUser } from "../lib/serializers.js"
import { getAuth } from "../middleware/auth.js"
import { validate } from "../middleware/validate.js"
import { recordActivity } from "../services/activity.js"
import { sendInviteEmail, sendStaffAddedUserNotice } from "../services/email.js"
import {
  invitePanelUser,
  issueTemporaryPassword,
} from "../services/panel-accounts.js"
import { hasLiveSubscription } from "../services/stripe.js"
import {
  assertEmailFree,
  createTenantWithFirstApp,
  loadTenant,
  tenantSlugSchema,
  tenantSlugTaken,
} from "../services/tenants.js"

/**
 * Account management for Yak staff, mounted behind requireSuperAdmin.
 *
 * A super admin creates customer accounts (tenants), places them on a tier,
 * and suspends or deletes them. Staff manage accounts but never see or change
 * what is in them: nothing here reads a customer's panel data, and the staff
 * database scope could not if it tried (see staffRead in db/schema.ts).
 */
export const adminRouter: Router = Router()

const idParamSchema = z.object({ id: z.string().min(1) })

/** How Yak staff are named to customers, in emails and activity alike. */
const STAFF_NAME = `${env.APP_NAME} support`

const nameSchema = z.string().trim().min(1).max(120)
const emailSchema = z.string().trim().toLowerCase().email()

/* -------------------------------------------------------------------------- */
/* Serialization                                                               */
/* -------------------------------------------------------------------------- */

/**
 * How much an app uses Yak, as counts and timestamps only. Read through the
 * `staff_app_usage` database function, because the staff scope cannot read
 * end user tables: the function aggregates on its side and never returns a
 * row, so who an account's users are and what they sent stays out of reach.
 */
type AppUsage = {
  syncedUsers: number
  eventsTotal: number
  eventsThisMonth: number
  /** Distinct end users with an event this calendar month (UTC). */
  activeUsersThisMonth: number
  lastEventAt: string | null
  reportsTotal: number
  reportsOpen: number
  reportsThisMonth: number
  activeApiKeys: number
  apiKeyLastUsedAt: string | null
  integrations: string[]
}

type AppUsageRow = {
  tenant_id: string
  app_id: string
  synced_users: string
  events_total: string
  events_this_month: string
  active_users_this_month: string
  last_event_at: Date | string | null
  reports_total: string
  reports_open: string
  reports_this_month: string
  active_api_keys: string
  api_key_last_used_at: Date | string | null
  integrations: string[] | null
}

const EMPTY_USAGE: AppUsage = {
  syncedUsers: 0,
  eventsTotal: 0,
  eventsThisMonth: 0,
  activeUsersThisMonth: 0,
  lastEventAt: null,
  reportsTotal: 0,
  reportsOpen: 0,
  reportsThisMonth: 0,
  activeApiKeys: 0,
  apiKeyLastUsedAt: null,
  integrations: [],
}

function isoOrNull(value: Date | string | null) {
  return value === null ? null : new Date(value).toISOString()
}

function latest(a: string | null, b: string | null) {
  if (!a) return b
  if (!b) return a
  return a > b ? a : b
}

async function loadAppUsage(tenantIds: string[]) {
  const result = await db.execute<AppUsageRow>(
    sql`select * from staff_app_usage(${sql.param(tenantIds)}::text[])`
  )

  return new Map(
    result.rows.map((row) => [
      row.app_id,
      {
        syncedUsers: Number(row.synced_users),
        eventsTotal: Number(row.events_total),
        eventsThisMonth: Number(row.events_this_month),
        activeUsersThisMonth: Number(row.active_users_this_month),
        lastEventAt: isoOrNull(row.last_event_at),
        reportsTotal: Number(row.reports_total),
        reportsOpen: Number(row.reports_open),
        reportsThisMonth: Number(row.reports_this_month),
        activeApiKeys: Number(row.active_api_keys),
        apiKeyLastUsedAt: isoOrNull(row.api_key_last_used_at),
        integrations: row.integrations ?? [],
      } satisfies AppUsage,
    ])
  )
}

/** An account's usage is its apps' added up. */
function sumUsage(items: AppUsage[]): AppUsage {
  return items.reduce<AppUsage>(
    (total, item) => ({
      syncedUsers: total.syncedUsers + item.syncedUsers,
      eventsTotal: total.eventsTotal + item.eventsTotal,
      eventsThisMonth: total.eventsThisMonth + item.eventsThisMonth,
      activeUsersThisMonth:
        total.activeUsersThisMonth + item.activeUsersThisMonth,
      lastEventAt: latest(total.lastEventAt, item.lastEventAt),
      reportsTotal: total.reportsTotal + item.reportsTotal,
      reportsOpen: total.reportsOpen + item.reportsOpen,
      reportsThisMonth: total.reportsThisMonth + item.reportsThisMonth,
      activeApiKeys: total.activeApiKeys + item.activeApiKeys,
      apiKeyLastUsedAt: latest(total.apiKeyLastUsedAt, item.apiKeyLastUsedAt),
      integrations: Array.from(
        new Set([...total.integrations, ...item.integrations])
      ).sort(),
    }),
    EMPTY_USAGE
  )
}

async function describeTenants(rows: Tenant[]) {
  if (rows.length === 0) {
    return []
  }

  const ids = rows.map((row) => row.id)

  // Apps are account metadata (names, not what they sent), which is the one
  // customer table besides settings and activity the staff scope may read.
  // One statement at a time: the request holds a single connection.
  const usage = await db
    .select({
      tenantId: userTable.tenantId,
      userCount: count(),
      lastActiveAt: max(userTable.lastLoginAt),
    })
    .from(userTable)
    .where(inArray(userTable.tenantId, ids))
    .groupBy(userTable.tenantId)
  const owners = await db
    .select({
      tenantId: userTable.tenantId,
      id: userTable.id,
      name: userTable.name,
      email: userTable.email,
    })
    .from(userTable)
    .where(and(inArray(userTable.tenantId, ids), eq(userTable.role, "owner")))
    .orderBy(asc(userTable.createdAt))
  const appRows = await db
    .select({
      tenantId: apps.tenantId,
      id: apps.id,
      name: apps.name,
      status: apps.status,
    })
    .from(apps)
    .where(inArray(apps.tenantId, ids))
    .orderBy(asc(apps.createdAt))

  const appUsage = await loadAppUsage(ids)

  const usageByTenant = new Map(usage.map((row) => [row.tenantId, row]))

  return rows.map((row) => {
    const stats = usageByTenant.get(row.id)
    const tenantApps = appRows
      .filter((app) => app.tenantId === row.id)
      .map(({ id, name, status }) => ({
        id,
        name,
        status,
        usage: appUsage.get(id) ?? EMPTY_USAGE,
      }))

    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      status: row.status,
      plan: row.plan,
      subscriptionStatus: row.subscriptionStatus,
      pendingPlan: row.pendingPlan,
      signupSource: row.signupSource,
      suspendedAt: row.suspendedAt?.toISOString() ?? null,
      suspendedReason: row.suspendedReason,
      createdAt: row.createdAt.toISOString(),
      userCount: Number(stats?.userCount ?? 0),
      owners: owners
        .filter((owner) => owner.tenantId === row.id)
        .map(({ id, name, email }) => ({ id, name, email })),
      appCount: tenantApps.length,
      apps: tenantApps,
      usage: sumUsage(tenantApps.map((app) => app.usage)),
      lastActiveAt: stats?.lastActiveAt?.toISOString() ?? null,
    }
  })
}

async function describeTenant(row: Tenant) {
  const [described] = await describeTenants([row])
  return described!
}

/**
 * Sends the invite and returns the `meta` every invite response carries.
 *
 * The password itself is handed back only when there is no email service at
 * all (a development machine), and only for a brand new login. A failed send
 * in production is reported as such, never compensated by showing staff a
 * customer's credential; they resend once email is back.
 */
async function deliverInvite(params: {
  email: string
  name: string
  temporaryPassword: string
  invitedByName: string
  workspaceName: string
  /** False for logins into an account that already holds data. */
  revealWhenUnconfigured?: boolean
}) {
  const inviteEmailSent = await sendInviteEmail({
    to: params.email,
    name: params.name,
    temporaryPassword: params.temporaryPassword,
    invitedByName: params.invitedByName,
    workspaceName: params.workspaceName,
  })

  const reveal =
    !inviteEmailSent &&
    !env.email.configured &&
    params.revealWhenUnconfigured !== false

  return {
    inviteEmailSent,
    temporaryPassword: reveal ? params.temporaryPassword : null,
  }
}

/* -------------------------------------------------------------------------- */
/* Tenants                                                                     */
/* -------------------------------------------------------------------------- */

adminRouter.get("/tenants", async (_req, res) => {
  const rows = await db.select().from(tenants).orderBy(desc(tenants.createdAt))
  res.json({ data: await describeTenants(rows) })
})

/**
 * Creates a customer account with its first app and its first owner. The app
 * is named after the account so the owner can start connecting straight away
 * and rename it later; the owner gets the usual invite, a temporary password
 * they must replace on first sign in.
 */
adminRouter.post(
  "/tenants",
  validate({
    body: z
      .object({
        name: nameSchema,
        slug: tenantSlugSchema,
        ownerName: nameSchema,
        ownerEmail: emailSchema,
      })
      .strict(),
  }),
  async (req, res) => {
    const actor = getAuth(req)
    const body = req.body as {
      name: string
      slug: string
      ownerName: string
      ownerEmail: string
    }

    if (await tenantSlugTaken(body.slug)) {
      throw new ConflictError("An account with that slug already exists")
    }

    // Checked up front so a taken email does not leave an ownerless tenant.
    await assertEmailFree(body.ownerEmail)

    const tenant = await createTenantWithFirstApp({
      name: body.name,
      slug: body.slug,
      createdByUserId: actor.user.id,
      signupSource: "admin",
    })
    const tenantId = tenant.id

    let owner: Awaited<ReturnType<typeof invitePanelUser>>

    try {
      owner = await invitePanelUser({
        tenantId,
        email: body.ownerEmail,
        name: body.ownerName,
        role: "owner",
        invitedByUserId: actor.user.id,
      })
    } catch (error) {
      // The email was free a moment ago; if it was taken in between, do not
      // leave behind an account nobody can sign in to.
      await db.delete(tenants).where(eq(tenants.id, tenantId))
      throw error
    }

    const meta = await deliverInvite({
      email: owner.user.email,
      name: owner.user.name,
      temporaryPassword: owner.temporaryPassword,
      invitedByName: STAFF_NAME,
      workspaceName: tenant.name,
    })

    await recordActivity({
      tenantId,
      userId: actor.user.id,
      action: "created",
      section: "admin",
      summary: `Created account ${tenant.name} with owner ${owner.user.email}`,
      metadata: { tenantId, ownerUserId: owner.user.id },
      ipAddress: req.ip,
    })

    res.status(201).json({
      data: {
        tenant: await describeTenant(tenant),
        owner: serializeSystemUser(owner.user),
      },
      meta,
    })
  }
)

adminRouter.get(
  "/tenants/:id",
  validate({ params: idParamSchema }),
  async (req, res) => {
    const tenant = await loadTenant(req.params.id as string)

    const users = await db
      .select()
      .from(userTable)
      .where(eq(userTable.tenantId, tenant.id))
      .orderBy(asc(userTable.createdAt))

    res.json({
      data: {
        tenant: await describeTenant(tenant),
        users: users.map(serializeSystemUser),
      },
    })
  }
)

adminRouter.patch(
  "/tenants/:id",
  validate({
    params: idParamSchema,
    body: z.object({ name: nameSchema }).strict(),
  }),
  async (req, res) => {
    const actor = getAuth(req)
    const tenant = await loadTenant(req.params.id as string)
    const { name } = req.body as { name: string }

    const [row] = await db
      .update(tenants)
      .set({ name, updatedAt: new Date() })
      .where(eq(tenants.id, tenant.id))
      .returning()

    await recordActivity({
      tenantId: tenant.id,
      userId: actor.user.id,
      action: "updated",
      section: "admin",
      summary: `Renamed account ${tenant.name} to ${name}`,
      ipAddress: req.ip,
    })

    res.json({ data: await describeTenant(row!) })
  }
)

/**
 * Places the account on a tier by hand: Scale contracts, goodwill, accounts
 * that pay outside Stripe. Refused while a Stripe subscription is live, since
 * the customer pays for that tier and the webhook would undo the change.
 */
adminRouter.patch(
  "/tenants/:id/plan",
  validate({
    params: idParamSchema,
    body: z.object({ plan: z.enum(PLAN_IDS) }).strict(),
  }),
  async (req, res) => {
    const actor = getAuth(req)
    const tenant = await loadTenant(req.params.id as string)
    const { plan } = req.body as { plan: PlanTier }

    if (hasLiveSubscription(tenant)) {
      throw new ConflictError(
        "This account pays through Stripe. Its owner changes the plan from Billing."
      )
    }

    const [row] = await db
      .update(tenants)
      // A tier placed by hand settles any checkout left over from sign up.
      .set({ plan, pendingPlan: null, pendingInterval: null, updatedAt: new Date() })
      .where(eq(tenants.id, tenant.id))
      .returning()

    await recordActivity({
      tenantId: tenant.id,
      userId: actor.user.id,
      action: "updated",
      section: "admin",
      summary: `Moved account ${tenant.name} from ${tenant.plan} to ${plan}`,
      metadata: { from: tenant.plan, to: plan },
      ipAddress: req.ip,
    })

    res.json({ data: await describeTenant(row!) })
  }
)

/**
 * Suspending blocks the tenant's panel and ingest API at once (both check the
 * tenant's status on every request) without deleting anything.
 */
adminRouter.post(
  "/tenants/:id/suspend",
  validate({
    params: idParamSchema,
    body: z
      .object({ reason: z.string().trim().max(280).optional() })
      .strict()
      .default({}),
  }),
  async (req, res) => {
    const actor = getAuth(req)
    const tenant = await loadTenant(req.params.id as string)
    const { reason } = req.body as { reason?: string }

    const [row] = await db
      .update(tenants)
      .set({
        status: "suspended",
        suspendedAt: new Date(),
        suspendedReason: reason || null,
        updatedAt: new Date(),
      })
      .where(eq(tenants.id, tenant.id))
      .returning()

    await recordActivity({
      tenantId: tenant.id,
      userId: actor.user.id,
      action: "updated",
      section: "admin",
      summary: `Suspended account ${tenant.name}`,
      metadata: { reason: reason ?? null },
      ipAddress: req.ip,
    })

    res.json({ data: await describeTenant(row!) })
  }
)

adminRouter.post(
  "/tenants/:id/reactivate",
  validate({ params: idParamSchema }),
  async (req, res) => {
    const actor = getAuth(req)
    const tenant = await loadTenant(req.params.id as string)

    const [row] = await db
      .update(tenants)
      .set({
        status: "active",
        suspendedAt: null,
        suspendedReason: null,
        updatedAt: new Date(),
      })
      .where(eq(tenants.id, tenant.id))
      .returning()

    await recordActivity({
      tenantId: tenant.id,
      userId: actor.user.id,
      action: "updated",
      section: "admin",
      summary: `Reactivated account ${tenant.name}`,
      ipAddress: req.ip,
    })

    res.json({ data: await describeTenant(row!) })
  }
)

/**
 * Permanently deletes the account and everything it owns, its panel users
 * included. Only a suspended account can be deleted, and the caller has to
 * repeat its slug, so this cannot happen in one careless click.
 *
 * Uploaded logos and avatars in R2 are not removed.
 */
adminRouter.delete(
  "/tenants/:id",
  validate({
    params: idParamSchema,
    body: z.object({ confirmSlug: z.string().trim() }).strict(),
  }),
  async (req, res) => {
    const actor = getAuth(req)
    const tenant = await loadTenant(req.params.id as string)
    const { confirmSlug } = req.body as { confirmSlug: string }

    if (tenant.status !== "suspended") {
      throw new BadRequestError("Suspend the account before deleting it")
    }

    if (confirmSlug !== tenant.slug) {
      throw new BadRequestError("The slug you typed does not match")
    }

    await db.delete(tenants).where(eq(tenants.id, tenant.id))

    await recordActivity({
      tenantId: null,
      userId: actor.user.id,
      action: "deleted",
      section: "admin",
      summary: `Deleted account ${tenant.name} (${tenant.slug})`,
      metadata: { tenantId: tenant.id },
      ipAddress: req.ip,
    })

    res.json({ data: { ok: true } })
  }
)

/* -------------------------------------------------------------------------- */
/* A tenant's panel users                                                      */
/* -------------------------------------------------------------------------- */

adminRouter.post(
  "/tenants/:id/users",
  validate({
    params: idParamSchema,
    body: z
      .object({
        name: nameSchema,
        email: emailSchema,
        role: z.enum(USER_ROLES).default("owner"),
      })
      .strict(),
  }),
  async (req, res) => {
    const actor = getAuth(req)
    const tenant = await loadTenant(req.params.id as string)
    const body = req.body as {
      name: string
      email: string
      role: (typeof USER_ROLES)[number]
    }

    // Account recovery only. While an account has an owner who can sign in,
    // that owner adds teammates from the panel; staff adding a login here
    // would be a way for staff to sign in to the customer's data.
    const owners = await db
      .select({ email: userTable.email })
      .from(userTable)
      .where(
        and(
          eq(userTable.tenantId, tenant.id),
          eq(userTable.role, "owner"),
          eq(userTable.banned, false)
        )
      )

    if (owners.length > 0) {
      throw new ForbiddenError(
        "This account already has an owner. Owners add teammates from the panel."
      )
    }

    // Nor once anyone has used the account. Data only arrives after someone
    // signs in (API keys and integrations are created from the panel), so
    // until then a login staff hand out can see nothing; afterwards it could.
    // An account in use recovers through the password reset email instead.
    const [used] = await db
      .select({ id: userTable.id })
      .from(userTable)
      .where(
        and(
          eq(userTable.tenantId, tenant.id),
          isNotNull(userTable.lastLoginAt)
        )
      )
      .limit(1)

    if (used) {
      throw new ForbiddenError(
        "Someone has already signed in to this account, so staff cannot add logins to it. Its team can recover access with the password reset email."
      )
    }

    const created = await invitePanelUser({
      tenantId: tenant.id,
      email: body.email,
      name: body.name,
      role: body.role,
      invitedByUserId: actor.user.id,
    })

    const meta = await deliverInvite({
      email: created.user.email,
      name: created.user.name,
      temporaryPassword: created.temporaryPassword,
      invitedByName: STAFF_NAME,
      workspaceName: tenant.name,
    })

    // Every remaining user hears about it, so access to a customer's data
    // is never restored without the customer knowing.
    const others = await db
      .select({ email: userTable.email })
      .from(userTable)
      .where(
        and(eq(userTable.tenantId, tenant.id), eq(userTable.banned, false))
      )

    await Promise.all(
      others
        .filter((other) => other.email !== created.user.email)
        .map((other) =>
          sendStaffAddedUserNotice({
            to: other.email,
            workspaceName: tenant.name,
            addedName: created.user.name,
            addedEmail: created.user.email,
            role: body.role,
          })
        )
    )

    await recordActivity({
      tenantId: tenant.id,
      userId: actor.user.id,
      action: "invited",
      section: "admin",
      summary: `Invited ${created.user.email} to ${tenant.name} as ${body.role}`,
      metadata: { invitedUserId: created.user.id },
      ipAddress: req.ip,
    })

    res.status(201).json({ data: serializeSystemUser(created.user), meta })
  }
)

adminRouter.post(
  "/tenants/:id/users/:userId/resend-invite",
  validate({
    params: z.object({ id: z.string().min(1), userId: z.string().min(1) }),
  }),
  async (req, res) => {
    const actor = getAuth(req)
    const tenant = await loadTenant(req.params.id as string)

    const [target] = await db
      .select()
      .from(userTable)
      .where(
        and(
          eq(userTable.id, req.params.userId as string),
          eq(userTable.tenantId, tenant.id)
        )
      )
      .limit(1)

    if (!target) {
      throw new NotFoundError("User")
    }

    // Re-keying someone who has already chosen their own password would let a
    // super admin sign in as them and read the customer's data. Once an
    // account is in use, only the password reset email can change it.
    if (!target.mustChangePassword) {
      throw new ConflictError(
        "This user has already signed in. They can reset their password from the sign in screen."
      )
    }

    const temporaryPassword = await issueTemporaryPassword(target.id)

    // Never shown to staff: this login belongs to an account with data in it.
    const meta = await deliverInvite({
      email: target.email,
      name: target.name,
      temporaryPassword,
      invitedByName: STAFF_NAME,
      workspaceName: tenant.name,
      revealWhenUnconfigured: false,
    })

    await recordActivity({
      tenantId: tenant.id,
      userId: actor.user.id,
      action: "invited",
      section: "admin",
      summary: `Resent invite to ${target.email}`,
      metadata: { targetUserId: target.id },
      ipAddress: req.ip,
    })

    res.json({ data: { ok: true }, meta })
  }
)

/* -------------------------------------------------------------------------- */
/* Super admins                                                                */
/* -------------------------------------------------------------------------- */

adminRouter.get("/super-admins", async (_req, res) => {
  const rows = await db
    .select()
    .from(userTable)
    .where(
      and(eq(userTable.role, SUPER_ADMIN_ROLE), eq(userTable.banned, false))
    )
    .orderBy(asc(userTable.createdAt))

  res.json({ data: rows.map(serializeSystemUser) })
})

adminRouter.post(
  "/super-admins",
  validate({
    body: z.object({ name: nameSchema, email: emailSchema }).strict(),
  }),
  async (req, res) => {
    const actor = getAuth(req)
    const body = req.body as { name: string; email: string }

    const created = await invitePanelUser({
      tenantId: null,
      email: body.email,
      name: body.name,
      role: SUPER_ADMIN_ROLE,
      invitedByUserId: actor.user.id,
    })

    const meta = await deliverInvite({
      email: created.user.email,
      name: created.user.name,
      temporaryPassword: created.temporaryPassword,
      invitedByName: actor.user.name,
      workspaceName: env.APP_NAME,
    })

    await recordActivity({
      tenantId: null,
      userId: actor.user.id,
      action: "invited",
      section: "admin",
      summary: `Invited super admin ${created.user.email}`,
      metadata: { invitedUserId: created.user.id },
      ipAddress: req.ip,
    })

    res.status(201).json({ data: serializeSystemUser(created.user), meta })
  }
)

/**
 * Removes a super admin's access. The account is deactivated rather than
 * deleted so the audit trail of what they did survives.
 */
adminRouter.delete(
  "/super-admins/:id",
  validate({ params: idParamSchema }),
  async (req, res) => {
    const actor = getAuth(req)
    const id = req.params.id as string

    if (id === actor.user.id) {
      throw new ForbiddenError("You cannot remove your own super admin account")
    }

    const [target] = await db
      .select()
      .from(userTable)
      .where(and(eq(userTable.id, id), eq(userTable.role, SUPER_ADMIN_ROLE)))
      .limit(1)

    if (!target) {
      throw new NotFoundError("Super admin")
    }

    await db
      .update(userTable)
      .set({ banned: true, banReason: "Access removed", updatedAt: new Date() })
      .where(eq(userTable.id, target.id))

    // Deactivation only matters if their live sessions end with it.
    await db.delete(sessionTable).where(eq(sessionTable.userId, target.id))

    await recordActivity({
      tenantId: null,
      userId: actor.user.id,
      action: "deleted",
      section: "admin",
      summary: `Removed super admin ${target.email}`,
      ipAddress: req.ip,
    })

    res.json({ data: { ok: true } })
  }
)

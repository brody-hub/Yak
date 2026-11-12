import { eq } from "drizzle-orm"
import { Router } from "express"
import { z } from "zod"

import { auth } from "../auth/auth.js"
import { PLAN_IDS } from "../billing/plans.js"
import { db } from "../db/index.js"
import { type PlanTier, tenants } from "../db/schema.js"
import { withStaffScope, withTenantScope } from "../db/scope.js"
import { env } from "../env.js"
import { ConflictError, NotFoundError } from "../lib/errors.js"
import { logger } from "../logger.js"
import { validate } from "../middleware/validate.js"
import { recordActivity } from "../services/activity.js"
import { createPanelUser } from "../services/panel-accounts.js"
import { type BillingInterval, isCheckoutPlan } from "../services/stripe.js"
import {
  availableTenantSlug,
  createTenantWithFirstApp,
  findUserByEmail,
} from "../services/tenants.js"

/**
 * Self-serve sign up: a new owner creates their account, its first app and
 * their own login in one step.
 *
 * The account starts on Free whatever tier was picked. A paid tier is kept as
 * `pending_plan` and paid for through Stripe Checkout once the owner has
 * confirmed their email and signed in; only Stripe's webhook moves the
 * account onto it. Nobody is signed in here: the confirmation link does that.
 */
export const signupRouter: Router = Router()

/** An unconfirmed sign up older than this no longer holds on to its email. */
const ABANDONED_AFTER_MS = 24 * 60 * 60 * 1000

const signupSchema = z
  .object({
    accountName: z.string().trim().min(1).max(120),
    name: z.string().trim().min(1).max(120),
    email: z.string().trim().toLowerCase().email(),
    password: z.string().min(12).max(128),
    plan: z
      .enum(PLAN_IDS)
      .refine((plan) => plan !== "scale", "Scale is arranged with our team")
      .default("free"),
    interval: z.enum(["monthly", "annual"]).default("monthly"),
  })
  .strict()

type SignupBody = z.infer<typeof signupSchema>

/**
 * Frees an email held by a sign up that was never confirmed, so a typo or a
 * stranger cannot keep a real owner out for good. Only ever removes an
 * account its owner created and never got into: nothing can be in it.
 */
async function releaseAbandonedSignup(email: string) {
  const existing = await findUserByEmail(email)

  if (!existing) {
    return
  }

  const [tenant] = existing.tenantId
    ? await db
        .select()
        .from(tenants)
        .where(eq(tenants.id, existing.tenantId))
        .limit(1)
    : []

  const abandoned =
    !existing.emailVerified &&
    existing.role === "owner" &&
    existing.lastLoginAt === null &&
    tenant?.signupSource === "self_serve" &&
    Date.now() - existing.createdAt.getTime() > ABANDONED_AFTER_MS

  if (!abandoned) {
    throw new ConflictError(
      existing.emailVerified
        ? "An account with this email already exists. Sign in instead."
        : "This email is waiting to be confirmed. Check your inbox for the link, or sign in to get a new one."
    )
  }

  await withStaffScope((staff) =>
    staff.delete(tenants).where(eq(tenants.id, tenant.id))
  )

  logger.info(
    { tenantId: tenant.id },
    "Removed an unconfirmed sign up to free its email"
  )
}

signupRouter.post("/", validate({ body: signupSchema }), async (req, res) => {
  if (!env.signupEnabled) {
    throw new NotFoundError("Sign up")
  }

  const body = req.body as SignupBody
  const plan: PlanTier = body.plan
  const pendingPlan = isCheckoutPlan(plan) ? plan : null
  const pendingInterval: BillingInterval | null = pendingPlan
    ? body.interval
    : null

  await releaseAbandonedSignup(body.email)

  const slug = await availableTenantSlug(body.accountName)

  const tenant = await withStaffScope(() =>
    createTenantWithFirstApp({
      name: body.accountName,
      slug,
      createdByUserId: null,
      signupSource: "self_serve",
      pendingPlan,
      pendingInterval,
    })
  )

  let ownerId: string

  try {
    const { user } = await createPanelUser({
      tenantId: tenant.id,
      email: body.email,
      name: body.name,
      role: "owner",
      password: body.password,
    })
    ownerId = user.id
  } catch (error) {
    // Lost a race for the email: leave no ownerless account behind.
    await withStaffScope((staff) =>
      staff.delete(tenants).where(eq(tenants.id, tenant.id))
    )
    throw error
  }

  await withTenantScope(tenant.id, () =>
    recordActivity({
      tenantId: tenant.id,
      userId: ownerId,
      action: "created",
      section: "signup",
      summary: pendingPlan
        ? `Signed up and picked ${plan} (${pendingInterval})`
        : "Signed up on Free",
      metadata: { plan, interval: pendingInterval },
      ipAddress: req.ip,
    })
  )

  // Answers the same whether or not the send worked; the sign in screen
  // offers a fresh link, and signing in unverified sends one too.
  await auth.api
    .sendVerificationEmail({ body: { email: body.email } })
    .catch((error: unknown) => {
      logger.error({ err: error }, "Could not send the sign up verification email")
    })

  res.status(201).json({ data: { email: body.email } })
})

import { eq } from "drizzle-orm"
import { Router } from "express"
import { z } from "zod"

import { auth } from "../auth/auth.js"
import { PLAN_IDS } from "../billing/plans.js"
import { db } from "../db/index.js"
import { type PlanTier, tenants } from "../db/schema.js"
import { withStaffScope, withTenantScope } from "../db/scope.js"
import { env } from "../env.js"
import { NotFoundError } from "../lib/errors.js"
import { logger } from "../logger.js"
import { validate } from "../middleware/validate.js"
import { recordActivity } from "../services/activity.js"
import { sendAccountExistsEmail } from "../services/email.js"
import { createPanelUser } from "../services/panel-accounts.js"
import { type BillingInterval, isCheckoutPlan } from "../services/stripe.js"
import {
  availableTenantSlug,
  createTenantWithFirstApp,
  findUserByEmail,
} from "../services/tenants.js"

/**
 * Self-serve sign up: a new owner creates their account, its first app and
 * their login in one step.
 *
 * The form takes no password. The login is created without one, and the
 * emailed link is where the owner chooses it. That link is the only way in,
 * so whoever reads the inbox is the only person who can ever hold the
 * account's password: someone who signs up with another person's email gains
 * nothing, because they never learn or set the password.
 *
 * The answer is the same whether or not the email already has an account
 * (that person is told by email instead), so the form cannot be used to find
 * out who uses Yak.
 *
 * The account starts on Free whatever tier was picked. A paid tier is kept as
 * `pending_plan` and paid for through Stripe Checkout once the owner is
 * signed in; only Stripe's webhook moves the account onto it.
 */
export const signupRouter: Router = Router()

const signupSchema = z
  .object({
    accountName: z.string().trim().min(1).max(120),
    name: z.string().trim().min(1).max(120),
    email: z.string().trim().toLowerCase().email(),
    plan: z
      .enum(PLAN_IDS)
      .refine((plan) => plan !== "scale", "Scale is arranged with our team")
      .default("free"),
    interval: z.enum(["monthly", "annual"]).default("monthly"),
  })
  .strict()

type SignupBody = z.infer<typeof signupSchema>

/**
 * Clears the way for a sign up. Returns false when the email already has a
 * real account, which must be left alone.
 *
 * A sign up whose password was never set is replaced: nobody has ever been
 * able to sign in to it, so nothing can be in it, and holding on to it would
 * let a typo or a stranger keep the real owner out.
 */
async function releasePendingSignup(email: string): Promise<boolean> {
  const existing = await findUserByEmail(email)

  if (!existing) {
    return true
  }

  const [tenant] = existing.tenantId
    ? await db
        .select()
        .from(tenants)
        .where(eq(tenants.id, existing.tenantId))
        .limit(1)
    : []

  const pending =
    !existing.emailVerified &&
    existing.role === "owner" &&
    existing.lastLoginAt === null &&
    tenant?.signupSource === "self_serve"

  if (!pending) {
    return false
  }

  await withStaffScope((staff) =>
    staff.delete(tenants).where(eq(tenants.id, tenant.id))
  )

  logger.info(
    { tenantId: tenant.id },
    "Replaced a sign up whose password was never set"
  )
  return true
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

  if (!(await releasePendingSignup(body.email))) {
    await sendAccountExistsEmail({ to: body.email })
    res.status(201).json({ data: { email: body.email } })
    return
  }

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
      selfServe: true,
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

  // The link to choose a password; sendResetPassword words it as the end of
  // sign up because the login is unverified. Answers the same whether or not
  // the send worked; the page offers to send it again.
  await auth.api
    .requestPasswordReset({ body: { email: body.email } })
    .catch((error: unknown) => {
      logger.error({ err: error }, "Could not send the sign up password link")
    })

  res.status(201).json({ data: { email: body.email } })
})

import { eq } from "drizzle-orm"
import { Router } from "express"
import { z } from "zod"

import { PLAN_IDS } from "../billing/plans.js"
import { db } from "../db/index.js"
import { type PlanTier, tenants } from "../db/schema.js"
import { env } from "../env.js"
import { BadRequestError } from "../lib/errors.js"
import { getAuth, getTenantId } from "../middleware/auth.js"
import { validate } from "../middleware/validate.js"
import { recordActivity } from "../services/activity.js"
import { describeBilling } from "../services/billing.js"
import {
  type BillingInterval,
  createCheckoutSession,
  createPortalSession,
} from "../services/stripe.js"
import { loadTenant } from "../services/tenants.js"

/**
 * What the Billing page shows an owner or admin, and the doors to Stripe:
 * Checkout to start a subscription, the customer portal to change or cancel
 * one. The tier itself only ever changes through Stripe's webhook.
 */
export const billingRouter: Router = Router()

billingRouter.get("/", async (req, res) => {
  const billing = await describeBilling(getTenantId(req))

  res.json({
    data: {
      ...billing,
      paymentsEnabled: env.stripe.configured,
    },
  })
})

/**
 * Starts a Stripe Checkout for a paid tier and returns its URL. With no body
 * it continues the tier picked at sign up.
 */
billingRouter.post(
  "/checkout",
  validate({
    body: z
      .object({
        plan: z.enum(PLAN_IDS).optional(),
        interval: z.enum(["monthly", "annual"]).optional(),
      })
      .strict()
      .default({}),
  }),
  async (req, res) => {
    const { user } = getAuth(req)
    const tenant = await loadTenant(getTenantId(req))
    const body = req.body as { plan?: PlanTier; interval?: BillingInterval }

    const plan = body.plan ?? tenant.pendingPlan

    if (!plan) {
      throw new BadRequestError("Pick a plan")
    }

    const interval = body.interval ?? tenant.pendingInterval ?? "monthly"

    const url = await createCheckoutSession({
      tenant,
      email: user.email,
      plan,
      interval,
    })

    res.json({ data: { url } })
  }
)

/** Stripe's customer portal: change tier, update the card, cancel. */
billingRouter.post("/portal", async (req, res) => {
  const tenant = await loadTenant(getTenantId(req))
  res.json({ data: { url: await createPortalSession(tenant) } })
})

/** Forgets the tier picked at sign up; the account stays on Free. */
billingRouter.delete("/pending", async (req, res) => {
  const { user } = getAuth(req)
  const tenantId = getTenantId(req)
  const tenant = await loadTenant(tenantId)

  if (tenant.pendingPlan) {
    await db
      .update(tenants)
      .set({ pendingPlan: null, pendingInterval: null, updatedAt: new Date() })
      .where(eq(tenants.id, tenantId))

    await recordActivity({
      tenantId,
      userId: user.id,
      action: "updated",
      section: "billing",
      summary: `Stayed on Free instead of ${tenant.pendingPlan}`,
      ipAddress: req.ip,
    })
  }

  res.json({ data: { ok: true } })
})

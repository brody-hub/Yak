import { Router } from "express"

import { env } from "../env.js"
import { getTenantId } from "../middleware/auth.js"
import { describeBilling } from "../services/billing.js"

/**
 * What the Billing page shows an owner or admin: the account's tier, the
 * tier's limits, and the live MAU meter that will drive the bill. Stripe is
 * not connected yet, so there is nothing to change here; `paymentsEnabled`
 * tells the panel whether to offer a checkout at all.
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

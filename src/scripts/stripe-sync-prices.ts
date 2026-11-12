import { getPlan } from "../billing/plans.js"
import { env } from "../env.js"
import {
  type BillingInterval,
  CHECKOUT_PLAN_IDS,
  getStripe,
  priceLookupKey,
} from "../services/stripe.js"

/**
 * Makes Stripe match src/billing/plans.ts: one product per paid tier, and a
 * monthly and annual price on it under the lookup keys checkout asks for.
 *
 * Safe to run again. A price whose amount no longer matches is replaced by a
 * new one that takes over its lookup key; Stripe keeps existing subscribers
 * on the old price until they change plan. Run once per mode:
 *
 *   npm run stripe:sync-prices            # whichever key STRIPE_SECRET_KEY is
 */
async function main() {
  const stripe = getStripe()
  console.log(`Syncing Yak prices to Stripe (${env.stripe.mode} mode)`)

  for (const planId of CHECKOUT_PLAN_IDS) {
    const plan = getPlan(planId)
    const productId = `yak_${planId}`

    const product = await stripe.products
      .retrieve(productId)
      .catch(() => null)

    if (!product) {
      await stripe.products.create({
        id: productId,
        name: `${env.APP_NAME} ${plan.name}`,
        metadata: { plan: planId },
      })
      console.log(`  created product ${productId}`)
    } else if (!product.active) {
      await stripe.products.update(productId, { active: true })
    }

    const wanted: [BillingInterval, number | null][] = [
      ["monthly", plan.monthlyPrice],
      ["annual", plan.annualPrice],
    ]

    for (const [interval, dollars] of wanted) {
      if (dollars === null) {
        continue
      }

      const lookupKey = priceLookupKey(planId, interval)
      const cents = dollars * 100
      const recurring = interval === "monthly" ? "month" : "year"

      const [existing] = (
        await stripe.prices.list({ lookup_keys: [lookupKey], limit: 1 })
      ).data

      if (
        existing?.active &&
        existing.unit_amount === cents &&
        existing.currency === "usd" &&
        existing.recurring?.interval === recurring
      ) {
        console.log(`  ${lookupKey}: $${dollars} already set`)
        continue
      }

      await stripe.prices.create({
        product: productId,
        currency: "usd",
        unit_amount: cents,
        recurring: { interval: recurring },
        lookup_key: lookupKey,
        transfer_lookup_key: true,
        metadata: { plan: planId, interval },
      })

      if (existing?.active) {
        await stripe.prices.update(existing.id, { active: false })
      }

      console.log(`  ${lookupKey}: set to $${dollars}`)
    }
  }

  console.log("Done")
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})

import { eq } from "drizzle-orm"
import Stripe from "stripe"

import { getPlan, PLAN_IDS } from "../billing/plans.js"
import { db } from "../db/index.js"
import { type PlanTier, type Tenant, tenants } from "../db/schema.js"
import { withTenantScope } from "../db/scope.js"
import { env } from "../env.js"
import {
  BadRequestError,
  ConflictError,
  ServiceUnavailableError,
} from "../lib/errors.js"
import { logger } from "../logger.js"

/**
 * Stripe subscriptions for the paid tiers.
 *
 * Prices are found by lookup key (`yak_growth_monthly`, ...) rather than by
 * id, so the same code runs against test and live mode and a price change is
 * a new price that takes over the key. `npm run stripe:sync-prices` creates
 * them from src/billing/plans.ts.
 *
 * Stripe is the source of truth for what an account pays: the webhook copies
 * the subscription's tier and status onto the tenant row, and checkout only
 * ever sends the customer to Stripe.
 */

export type BillingInterval = "monthly" | "annual"

/** Tiers a customer can buy themselves. Free costs nothing; Scale is a contract. */
export const CHECKOUT_PLAN_IDS = ["starter", "growth", "pro", "studio"] as const

export type CheckoutPlan = (typeof CHECKOUT_PLAN_IDS)[number]

export function isCheckoutPlan(plan: PlanTier): plan is CheckoutPlan {
  return (CHECKOUT_PLAN_IDS as readonly string[]).includes(plan)
}

/** Statuses in which the customer keeps the tier they pay for. */
const PAID_STATUSES = new Set<Stripe.Subscription.Status>([
  "active",
  "trialing",
  // Stripe is still retrying the card; the tier stays until it gives up.
  "past_due",
])

/** Statuses after which the subscription can never become active again. */
const ENDED_STATUSES = new Set<Stripe.Subscription.Status>([
  "canceled",
  "incomplete_expired",
])

let client: Stripe | null = null

/** Only the secret key is needed to talk to Stripe (the price sync uses this). */
export function getStripe(): Stripe {
  if (!env.stripe.secretKey) {
    throw new ServiceUnavailableError("Online payments are not set up yet")
  }

  client ??= new Stripe(env.stripe.secretKey!, {
    appInfo: { name: env.APP_NAME },
  })

  return client
}

/** Customers are only sent to Stripe once the webhook can bring them back. */
function assertPaymentsEnabled() {
  if (!env.stripe.configured) {
    throw new ServiceUnavailableError("Online payments are not set up yet")
  }
}

export function priceLookupKey(plan: CheckoutPlan, interval: BillingInterval) {
  return `yak_${plan}_${interval}`
}

/** The tier a price stands for, from its lookup key; null for anything else. */
export function planFromLookupKey(key: string | null | undefined): PlanTier | null {
  const match = key?.match(/^yak_([a-z]+)_(monthly|annual)$/)
  const plan = match?.[1] as PlanTier | undefined

  return plan && PLAN_IDS.includes(plan) ? plan : null
}

async function findPrice(plan: CheckoutPlan, interval: BillingInterval) {
  const key = priceLookupKey(plan, interval)
  const prices = await getStripe().prices.list({
    lookup_keys: [key],
    active: true,
    limit: 1,
  })

  const price = prices.data[0]

  if (!price) {
    logger.error({ key }, "No Stripe price for this lookup key; run stripe:sync-prices")
    throw new ServiceUnavailableError(
      `${getPlan(plan).name} is not available to buy right now`
    )
  }

  return price
}

export function hasLiveSubscription(tenant: Tenant) {
  return Boolean(
    tenant.stripeSubscriptionId &&
    tenant.subscriptionStatus &&
    PAID_STATUSES.has(tenant.subscriptionStatus as Stripe.Subscription.Status)
  )
}

/**
 * The tenant's Stripe customer, created on first checkout. Runs in the
 * request's tenant scope, which may update its own tenant row.
 */
async function ensureCustomer(tenant: Tenant, email: string) {
  if (tenant.stripeCustomerId) {
    return tenant.stripeCustomerId
  }

  const customer = await getStripe().customers.create(
    {
      email,
      name: tenant.name,
      metadata: { tenantId: tenant.id, tenantSlug: tenant.slug },
    },
    // Two quick clicks must not make two customers for one account.
    { idempotencyKey: `customer-${tenant.id}` }
  )

  await db
    .update(tenants)
    .set({ stripeCustomerId: customer.id, updatedAt: new Date() })
    .where(eq(tenants.id, tenant.id))

  return customer.id
}

export async function createCheckoutSession(params: {
  tenant: Tenant
  email: string
  plan: PlanTier
  interval: BillingInterval
}) {
  const { tenant, plan, interval } = params

  assertPaymentsEnabled()

  if (!isCheckoutPlan(plan)) {
    throw new BadRequestError(
      plan === "scale"
        ? "Scale is arranged with our team; get in touch"
        : "The Free plan needs no checkout"
    )
  }

  if (interval === "annual" && getPlan(plan).annualPrice === null) {
    throw new BadRequestError(`${getPlan(plan).name} is billed monthly only`)
  }

  if (hasLiveSubscription(tenant)) {
    throw new ConflictError(
      "This account already has a subscription. Change it from Manage billing."
    )
  }

  const price = await findPrice(plan, interval)
  const customer = await ensureCustomer(tenant, params.email)

  const session = await getStripe().checkout.sessions.create({
    mode: "subscription",
    customer,
    client_reference_id: tenant.id,
    line_items: [{ price: price.id, quantity: 1 }],
    metadata: { tenantId: tenant.id },
    subscription_data: { metadata: { tenantId: tenant.id } },
    allow_promotion_codes: true,
    success_url: `${env.APP_URL}/settings/billing?checkout=success`,
    cancel_url: `${env.APP_URL}/settings/billing?checkout=cancelled`,
  })

  if (!session.url) {
    throw new ServiceUnavailableError("Stripe did not return a checkout page")
  }

  return session.url
}

export async function createPortalSession(tenant: Tenant) {
  assertPaymentsEnabled()

  if (!tenant.stripeCustomerId) {
    throw new BadRequestError("This account has no billing details yet")
  }

  const session = await getStripe().billingPortal.sessions.create({
    customer: tenant.stripeCustomerId,
    return_url: `${env.APP_URL}/settings/billing`,
  })

  return session.url
}

/* -------------------------------------------------------------------------- */
/* Webhook                                                                     */
/* -------------------------------------------------------------------------- */

export function constructWebhookEvent(body: Buffer, signature: string) {
  return getStripe().webhooks.constructEvent(
    body,
    signature,
    env.stripe.webhookSecret!
  )
}

function customerId(value: string | Stripe.Customer | Stripe.DeletedCustomer) {
  return typeof value === "string" ? value : value.id
}

async function findTenantForSubscription(subscription: Stripe.Subscription) {
  const byCustomer = customerId(subscription.customer)
  const [row] = await db
    .select()
    .from(tenants)
    .where(eq(tenants.stripeCustomerId, byCustomer))
    .limit(1)

  if (row) {
    return row
  }

  // Only trusted when the customer is not attached to another tenant yet.
  const fromMetadata = subscription.metadata?.tenantId

  if (!fromMetadata) {
    return null
  }

  const [byId] = await db
    .select()
    .from(tenants)
    .where(eq(tenants.id, fromMetadata))
    .limit(1)

  return byId && !byId.stripeCustomerId ? byId : null
}

/**
 * Copies a subscription's current state onto its tenant. Always fetched fresh
 * from Stripe rather than read from the event, so events arriving late or out
 * of order, or twice, all settle on the same answer.
 */
export async function syncSubscription(subscriptionId: string) {
  const subscription = await getStripe().subscriptions.retrieve(subscriptionId)
  const tenant = await findTenantForSubscription(subscription)

  if (!tenant) {
    logger.warn(
      { subscriptionId, customer: customerId(subscription.customer) },
      "Stripe subscription matches no account"
    )
    return
  }

  const price = subscription.items.data[0]?.price
  const plan = planFromLookupKey(price?.lookup_key)
  const isCurrent = tenant.stripeSubscriptionId === subscription.id

  await withTenantScope(tenant.id, async (scoped) => {
    if (PAID_STATUSES.has(subscription.status)) {
      if (!plan) {
        logger.error(
          { subscriptionId, lookupKey: price?.lookup_key },
          "Stripe subscription price has no Yak lookup key"
        )
        return
      }

      await scoped
        .update(tenants)
        .set({
          plan,
          stripeCustomerId: customerId(subscription.customer),
          stripeSubscriptionId: subscription.id,
          subscriptionStatus: subscription.status,
          pendingPlan: null,
          pendingInterval: null,
          updatedAt: new Date(),
        })
        .where(eq(tenants.id, tenant.id))

      logger.info(
        { tenantId: tenant.id, plan, status: subscription.status },
        "Subscription synced"
      )
      return
    }

    // An old or abandoned subscription must not knock the account off the
    // tier a newer one pays for, nor off one staff placed it on by hand.
    if (!isCurrent) {
      return
    }

    const ended = ENDED_STATUSES.has(subscription.status)

    await scoped
      .update(tenants)
      .set({
        plan: "free",
        stripeSubscriptionId: ended ? null : subscription.id,
        subscriptionStatus: subscription.status,
        updatedAt: new Date(),
      })
      .where(eq(tenants.id, tenant.id))

    logger.info(
      { tenantId: tenant.id, status: subscription.status },
      "Subscription lapsed; account moved to Free"
    )
  })
}

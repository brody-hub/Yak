import express, { Router } from "express"
import type Stripe from "stripe"

import { env } from "../env.js"
import { logger } from "../logger.js"
import { constructWebhookEvent, syncSubscription } from "../services/stripe.js"

/**
 * Stripe's webhook. Mounted before the JSON body parser: the signature covers
 * the exact bytes Stripe sent, so the body has to arrive untouched.
 *
 * Every handled event comes down to "fetch this subscription and copy its
 * state onto the account", which is safe to repeat, so Stripe's retries and
 * duplicate deliveries need no bookkeeping here.
 */
export const stripeWebhookRouter: Router = Router()

function subscriptionIdOf(event: Stripe.Event): string | null {
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object
      if (session.mode !== "subscription" || !session.subscription) {
        return null
      }
      return typeof session.subscription === "string"
        ? session.subscription
        : session.subscription.id
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
    case "customer.subscription.paused":
    case "customer.subscription.resumed":
      return event.data.object.id
    default:
      return null
  }
}

stripeWebhookRouter.post(
  "/",
  express.raw({ type: "application/json", limit: "1mb" }),
  async (req, res) => {
    if (!env.stripe.configured) {
      res.status(404).json({ error: { code: "not_found", message: "Not found" } })
      return
    }

    const signature = req.get("stripe-signature")

    if (!signature || !Buffer.isBuffer(req.body)) {
      res
        .status(400)
        .json({ error: { code: "bad_request", message: "Missing signature" } })
      return
    }

    let event: Stripe.Event

    try {
      event = constructWebhookEvent(req.body, signature)
    } catch (error) {
      logger.warn({ err: error }, "Rejected Stripe webhook with a bad signature")
      res
        .status(400)
        .json({ error: { code: "bad_request", message: "Invalid signature" } })
      return
    }

    const subscriptionId = subscriptionIdOf(event)

    if (subscriptionId) {
      // A failure answers 500 so Stripe retries later.
      await syncSubscription(subscriptionId)
    } else if (event.type === "invoice.payment_failed") {
      // The subscription moves to past_due and its own update event follows;
      // logged so a failing card is visible before then.
      logger.warn({ eventId: event.id }, "Stripe invoice payment failed")
    }

    res.json({ received: true })
  }
)

import { lookup } from "node:dns/promises"
import { isIP } from "node:net"

import { and, eq } from "drizzle-orm"

import { db } from "../db/index.js"
import { webhookDeliveries, webhookEndpoints } from "../db/schema.js"
import { decryptSecret, newId, signPayload } from "../lib/crypto.js"
import { logger } from "../logger.js"

export const WEBHOOK_EVENTS = [
  "report.created",
  "report.updated",
  "report.status_changed",
  "report.replied",
  "report.resolved",
] as const

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number]

export function isValidWebhookEvent(value: string): value is WebhookEvent {
  return (WEBHOOK_EVENTS as readonly string[]).includes(value)
}

/* -------------------------------------------------------------------------- */
/* SSRF protection                                                             */
/* -------------------------------------------------------------------------- */

function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 6) {
    const normalized = address.toLowerCase()
    return (
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe80") ||
      normalized.startsWith("::ffff:")
    )
  }

  const parts = address.split(".").map(Number)

  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) {
    return true
  }

  const [a = 0, b = 0] = parts

  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  )
}

/**
 * Webhook URLs are operator supplied and this server makes outbound requests to
 * them, so anything resolving into a private range is rejected. Without this an
 * admin could use the panel to reach Railway's internal network.
 */
export async function assertSafeWebhookUrl(value: string): Promise<void> {
  let parsed: URL

  try {
    parsed = new URL(value)
  } catch {
    throw new Error("Webhook URL is not a valid URL")
  }

  if (parsed.protocol !== "https:") {
    throw new Error("Webhook URL must use https")
  }

  const host = parsed.hostname.toLowerCase()

  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) {
    throw new Error("Webhook URL may not point at an internal host")
  }

  const addresses = isIP(host)
    ? [{ address: host }]
    : await lookup(host, { all: true }).catch(() => {
        throw new Error("Webhook host could not be resolved")
      })

  if (addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw new Error("Webhook URL may not point at a private network address")
  }
}

/* -------------------------------------------------------------------------- */
/* Dispatch                                                                    */
/* -------------------------------------------------------------------------- */

const MAX_ATTEMPTS = 3
const RETRY_DELAYS_MS = [1_000, 5_000]

async function deliver(params: {
  deliveryId: string
  url: string
  secret: string
  event: WebhookEvent
  payload: Record<string, unknown>
}): Promise<void> {
  const body = JSON.stringify({
    id: params.deliveryId,
    event: params.event,
    createdAt: new Date().toISOString(),
    data: params.payload,
  })

  const timestamp = Math.floor(Date.now() / 1000)
  const signature = signPayload(`${timestamp}.${body}`, params.secret)

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(params.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Yak-Event": params.event,
          "X-Yak-Delivery": params.deliveryId,
          "X-Yak-Timestamp": String(timestamp),
          "X-Yak-Signature": `v1=${signature}`,
        },
        body,
        signal: AbortSignal.timeout(10_000),
      })

      if (response.ok) {
        await db
          .update(webhookDeliveries)
          .set({
            status: "succeeded",
            attempts: attempt,
            responseStatus: response.status,
            deliveredAt: new Date(),
            error: null,
          })
          .where(eq(webhookDeliveries.id, params.deliveryId))
        return
      }

      // 4xx other than 429 will not succeed on retry.
      const retryable = response.status === 429 || response.status >= 500

      if (!retryable || attempt === MAX_ATTEMPTS) {
        await db
          .update(webhookDeliveries)
          .set({
            status: "failed",
            attempts: attempt,
            responseStatus: response.status,
            error: `Endpoint responded ${response.status}`,
          })
          .where(eq(webhookDeliveries.id, params.deliveryId))
        return
      }
    } catch (error) {
      if (attempt === MAX_ATTEMPTS) {
        await db
          .update(webhookDeliveries)
          .set({
            status: "failed",
            attempts: attempt,
            error: error instanceof Error ? error.message : "Request failed",
          })
          .where(eq(webhookDeliveries.id, params.deliveryId))
        return
      }
    }

    const delay = RETRY_DELAYS_MS[attempt - 1] ?? 5_000
    await new Promise((resolve) => setTimeout(resolve, delay))
  }
}

/**
 * Queues an event to every enabled endpoint subscribed to it.
 *
 * Returns immediately; delivery runs in the background so panel requests are
 * never held open waiting on a third party endpoint.
 */
export async function dispatchWebhookEvent(
  event: WebhookEvent,
  payload: Record<string, unknown>
): Promise<void> {
  try {
    const endpoints = await db
      .select()
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.enabled, true))

    const subscribed = endpoints.filter((endpoint) =>
      endpoint.events.includes(event)
    )

    for (const endpoint of subscribed) {
      const deliveryId = newId()

      await db.insert(webhookDeliveries).values({
        id: deliveryId,
        endpointId: endpoint.id,
        event,
        payload,
        status: "pending",
      })

      void deliver({
        deliveryId,
        url: endpoint.url,
        secret: decryptSecret(endpoint.secretEncrypted),
        event,
        payload,
      }).catch((error: unknown) => {
        logger.warn({ err: error, event }, "Webhook delivery crashed")
      })
    }
  } catch (error) {
    logger.warn({ err: error, event }, "Could not queue webhook event")
  }
}

export async function listDeliveries(endpointId: string, limit = 25) {
  return db
    .select()
    .from(webhookDeliveries)
    .where(and(eq(webhookDeliveries.endpointId, endpointId)))
    .limit(limit)
}

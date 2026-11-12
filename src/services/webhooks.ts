import { lookup as lookupCallback, type LookupAddress } from "node:dns"
import { lookup } from "node:dns/promises"
import { request as httpsRequest } from "node:https"
import { isIP, type LookupFunction } from "node:net"

import { and, eq } from "drizzle-orm"

import { db } from "../db/index.js"
import { webhookDeliveries, webhookEndpoints } from "../db/schema.js"
import { withTenantScope } from "../db/scope.js"
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
      normalized === "::" ||
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe80") ||
      normalized.startsWith("fe9") ||
      normalized.startsWith("fea") ||
      normalized.startsWith("feb") ||
      // IPv4 embedded one way or another: judge the IPv4 part.
      normalized.startsWith("::ffff:") ||
      normalized.startsWith("::") ||
      normalized.startsWith("64:ff9b:") ||
      normalized.startsWith("2002:")
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

  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".internal")
  ) {
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

/**
 * Resolves like dns.lookup but refuses private addresses, and is the lookup
 * the request itself connects with. Checking the name once and then letting
 * the HTTP client resolve it again would let a hostname with a near-zero TTL
 * answer publicly for the check and privately for the connection.
 */
const publicOnlyLookup: LookupFunction = (hostname, options, callback) => {
  lookupCallback(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) {
      callback(error, "", 4)
      return
    }

    const list = addresses as LookupAddress[]

    if (list.length === 0 || list.some((entry) => isPrivateAddress(entry.address))) {
      callback(
        new Error("Webhook URL may not point at a private network address"),
        "",
        4
      )
      return
    }

    if (options.all) {
      ;(callback as unknown as (error: null, addresses: LookupAddress[]) => void)(
        null,
        list
      )
      return
    }

    callback(null, list[0]!.address, list[0]!.family)
  })
}

/**
 * POSTs to a customer's endpoint and answers its status code. No redirects
 * are followed (a 3xx is just a status), so the signed payload only ever
 * goes to an address the lookup above approved.
 */
function postToEndpoint(
  url: string,
  headers: Record<string, string>,
  body: string,
  timeoutMs: number
): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      url,
      {
        method: "POST",
        headers: { ...headers, "Content-Length": Buffer.byteLength(body) },
        lookup: publicOnlyLookup,
        timeout: timeoutMs,
      },
      (response) => {
        // The body is never read or stored; drain it so the socket closes.
        response.resume()
        resolve(response.statusCode ?? 0)
      }
    )

    request.on("timeout", () => {
      request.destroy(new Error("Endpoint timed out"))
    })
    request.on("error", reject)
    request.end(body)
  })
}

/* -------------------------------------------------------------------------- */
/* Dispatch                                                                    */
/* -------------------------------------------------------------------------- */

const MAX_ATTEMPTS = 3
const RETRY_DELAYS_MS = [1_000, 5_000]

/** Records the outcome of a delivery attempt, in the tenant's own scope. */
function markDelivery(
  tenantId: string,
  deliveryId: string,
  values: Partial<typeof webhookDeliveries.$inferInsert>
): Promise<void> {
  return withTenantScope(tenantId, async () => {
    await db
      .update(webhookDeliveries)
      .set(values)
      .where(
        and(
          eq(webhookDeliveries.tenantId, tenantId),
          eq(webhookDeliveries.id, deliveryId)
        )
      )
  })
}

/**
 * Retries over several seconds, so it holds no database connection between
 * attempts; each status write opens a short scope of its own.
 */
async function deliver(params: {
  tenantId: string
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
      // Checked again on every attempt, not just when the endpoint was saved:
      // a hostname can be re-pointed at a private address afterwards.
      await assertSafeWebhookUrl(params.url)

      // A redirect could send the signed payload, or the request itself,
      // somewhere the URL check never saw, so none is followed: a 3xx is a
      // failed delivery. The connection goes only to an address the lookup
      // approved at connect time.
      const status = await postToEndpoint(
        params.url,
        {
          "Content-Type": "application/json",
          "X-Yak-Event": params.event,
          "X-Yak-Delivery": params.deliveryId,
          "X-Yak-Timestamp": String(timestamp),
          "X-Yak-Signature": `v1=${signature}`,
        },
        body,
        10_000
      )
      const response = { ok: status >= 200 && status < 300, status }

      if (response.ok) {
        await markDelivery(params.tenantId, params.deliveryId, {
          status: "succeeded",
          attempts: attempt,
          responseStatus: response.status,
          deliveredAt: new Date(),
          error: null,
        })
        return
      }

      // 4xx other than 429 will not succeed on retry.
      const retryable = response.status === 429 || response.status >= 500

      if (!retryable || attempt === MAX_ATTEMPTS) {
        await markDelivery(params.tenantId, params.deliveryId, {
          status: "failed",
          attempts: attempt,
          responseStatus: response.status,
          error: `Endpoint responded ${response.status}`,
        })
        return
      }
    } catch (error) {
      if (attempt === MAX_ATTEMPTS) {
        await markDelivery(params.tenantId, params.deliveryId, {
          status: "failed",
          attempts: attempt,
          error: error instanceof Error ? error.message : "Request failed",
        })
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
 * never held open waiting on a third party endpoint. Runs in its own database
 * scope because callers fire and forget it past the end of their request.
 *
 * `options.app` names the app the event came from; it is added to the payload
 * as `app: { id, name }` so an endpoint receiving several apps' events can tell
 * them apart. Account-level events leave it out.
 */
export function dispatchWebhookEvent(
  tenantId: string,
  event: WebhookEvent,
  payload: Record<string, unknown>,
  options: { app?: { id: string; name: string } } = {}
): Promise<void> {
  const data = options.app
    ? { app: { id: options.app.id, name: options.app.name }, ...payload }
    : payload

  return withTenantScope(tenantId, async () => {
    try {
      const endpoints = await db
        .select()
        .from(webhookEndpoints)
        .where(
          and(
            eq(webhookEndpoints.tenantId, tenantId),
            eq(webhookEndpoints.enabled, true)
          )
        )

      const subscribed = endpoints.filter((endpoint) =>
        endpoint.events.includes(event)
      )

      for (const endpoint of subscribed) {
        const deliveryId = newId()

        await db.insert(webhookDeliveries).values({
          id: deliveryId,
          tenantId,
          endpointId: endpoint.id,
          event,
          payload: data,
          status: "pending",
        })

        void deliver({
          tenantId,
          deliveryId,
          url: endpoint.url,
          secret: decryptSecret(
            endpoint.secretEncrypted,
            webhookBinding(tenantId)
          ),
          event,
          payload: data,
        }).catch((error: unknown) => {
          logger.warn({ err: error, event }, "Webhook delivery crashed")
        })
      }
    } catch (error) {
      logger.warn({ err: error, event }, "Could not queue webhook event")
    }
  })
}

export async function listDeliveries(
  tenantId: string,
  endpointId: string,
  limit = 25
) {
  return db
    .select()
    .from(webhookDeliveries)
    .where(
      and(
        eq(webhookDeliveries.tenantId, tenantId),
        eq(webhookDeliveries.endpointId, endpointId)
      )
    )
    .limit(limit)
}

/** What a stored webhook signing secret is sealed to; see encryptSecret. */
export function webhookBinding(tenantId: string): string {
  return `${tenantId}:webhook`
}

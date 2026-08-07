import { desc, eq } from "drizzle-orm"
import { Router } from "express"
import { z } from "zod"

import { db } from "../db/index.js"
import { webhookDeliveries, webhookEndpoints } from "../db/schema.js"
import { encryptSecret, generateWebhookSecret, newId } from "../lib/crypto.js"
import { BadRequestError, NotFoundError } from "../lib/errors.js"
import { getAuth } from "../middleware/auth.js"
import { validate } from "../middleware/validate.js"
import { recordActivity } from "../services/activity.js"
import { WEBHOOK_EVENTS, assertSafeWebhookUrl } from "../services/webhooks.js"

export const webhookEndpointsRouter: Router = Router()

const idParamSchema = z.object({ id: z.string().min(1) })

function serialize(row: typeof webhookEndpoints.$inferSelect) {
  return {
    id: row.id,
    url: row.url,
    events: row.events,
    enabled: row.enabled,
    secretHint: row.secretHint,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

webhookEndpointsRouter.get("/events", (_req, res) => {
  res.json({ data: WEBHOOK_EVENTS })
})

webhookEndpointsRouter.get("/", async (_req, res) => {
  const rows = await db
    .select()
    .from(webhookEndpoints)
    .orderBy(desc(webhookEndpoints.createdAt))

  res.json({ data: rows.map(serialize) })
})

/**
 * Registers an outbound endpoint. The signing secret is returned once so the
 * integrator can verify the `X-Yak-Signature` header on delivery.
 */
webhookEndpointsRouter.post(
  "/",
  validate({
    body: z
      .object({
        url: z.string().trim().url().max(500),
        events: z.array(z.enum(WEBHOOK_EVENTS)).min(1),
        enabled: z.boolean().default(true),
      })
      .strict(),
  }),
  async (req, res) => {
    const { user } = getAuth(req)
    const body = req.body as {
      url: string
      events: string[]
      enabled: boolean
    }

    await assertSafeWebhookUrl(body.url).catch((error: unknown) => {
      throw new BadRequestError(
        error instanceof Error ? error.message : "Invalid webhook URL"
      )
    })

    const secret = generateWebhookSecret()

    const [row] = await db
      .insert(webhookEndpoints)
      .values({
        id: newId(),
        url: body.url,
        events: body.events,
        enabled: body.enabled,
        secretEncrypted: encryptSecret(secret),
        secretHint: `${secret.slice(0, 11)}…`,
        createdByUserId: user.id,
      })
      .returning()

    if (!row) {
      throw new NotFoundError("Webhook endpoint")
    }

    await recordActivity({
      userId: user.id,
      action: "created",
      section: "user-management",
      summary: `Registered webhook endpoint ${body.url}`,
      ipAddress: req.ip,
    })

    res.status(201).json({
      data: serialize(row),
      meta: {
        secret,
        notice: "Copy this signing secret now. It cannot be shown again.",
      },
    })
  }
)

webhookEndpointsRouter.patch(
  "/:id",
  validate({
    params: idParamSchema,
    body: z
      .object({
        url: z.string().trim().url().max(500).optional(),
        events: z.array(z.enum(WEBHOOK_EVENTS)).min(1).optional(),
        enabled: z.boolean().optional(),
      })
      .strict()
      .refine((value) => Object.keys(value).length > 0, {
        message: "Provide at least one field to update",
      }),
  }),
  async (req, res) => {
    const { user } = getAuth(req)
    const body = req.body as {
      url?: string
      events?: string[]
      enabled?: boolean
    }

    if (body.url) {
      await assertSafeWebhookUrl(body.url).catch((error: unknown) => {
        throw new BadRequestError(
          error instanceof Error ? error.message : "Invalid webhook URL"
        )
      })
    }

    const [row] = await db
      .update(webhookEndpoints)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(webhookEndpoints.id, req.params.id as string))
      .returning()

    if (!row) {
      throw new NotFoundError("Webhook endpoint")
    }

    await recordActivity({
      userId: user.id,
      action: "updated",
      section: "user-management",
      summary: `Updated webhook endpoint ${row.url}`,
      ipAddress: req.ip,
    })

    res.json({ data: serialize(row) })
  }
)

webhookEndpointsRouter.delete(
  "/:id",
  validate({ params: idParamSchema }),
  async (req, res) => {
    const { user } = getAuth(req)
    const id = req.params.id as string

    const [row] = await db
      .select()
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.id, id))
      .limit(1)

    if (!row) {
      throw new NotFoundError("Webhook endpoint")
    }

    await db.delete(webhookEndpoints).where(eq(webhookEndpoints.id, id))

    await recordActivity({
      userId: user.id,
      action: "deleted",
      section: "user-management",
      summary: `Removed webhook endpoint ${row.url}`,
      ipAddress: req.ip,
    })

    res.json({ data: { ok: true } })
  }
)

webhookEndpointsRouter.get(
  "/:id/deliveries",
  validate({ params: idParamSchema }),
  async (req, res) => {
    const rows = await db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.endpointId, req.params.id as string))
      .orderBy(desc(webhookDeliveries.createdAt))
      .limit(50)

    res.json({
      data: rows.map((row) => ({
        id: row.id,
        event: row.event,
        status: row.status,
        attempts: row.attempts,
        responseStatus: row.responseStatus,
        error: row.error,
        createdAt: row.createdAt.toISOString(),
        deliveredAt: row.deliveredAt?.toISOString() ?? null,
      })),
    })
  }
)

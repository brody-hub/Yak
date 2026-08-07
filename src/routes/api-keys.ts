import { desc, eq } from "drizzle-orm"
import { Router } from "express"
import { z } from "zod"

import { API_KEY_SCOPES, API_KEY_SCOPE_LABELS } from "../auth/context.js"
import { db } from "../db/index.js"
import { apiKeys } from "../db/schema.js"
import { generateApiKey, newId } from "../lib/crypto.js"
import { NotFoundError } from "../lib/errors.js"
import { serializeApiKey } from "../lib/serializers.js"
import { getAuth } from "../middleware/auth.js"
import { validate } from "../middleware/validate.js"
import { recordActivity } from "../services/activity.js"

export const apiKeysRouter: Router = Router()

apiKeysRouter.get("/scopes", (_req, res) => {
  res.json({
    data: API_KEY_SCOPES.map((scope) => ({
      id: scope,
      description: API_KEY_SCOPE_LABELS[scope],
    })),
  })
})

apiKeysRouter.get("/", async (_req, res) => {
  const rows = await db
    .select()
    .from(apiKeys)
    .orderBy(desc(apiKeys.createdAt))

  res.json({ data: rows.map(serializeApiKey) })
})

/**
 * Mints a key. The plaintext is returned exactly once here and never again;
 * only its SHA-256 hash is stored.
 */
apiKeysRouter.post(
  "/",
  validate({
    body: z
      .object({
        name: z.string().trim().min(1).max(80),
        scopes: z.array(z.enum(API_KEY_SCOPES)).min(1),
        expiresAt: z.coerce.date().nullable().default(null),
      })
      .strict(),
  }),
  async (req, res) => {
    const { user } = getAuth(req)
    const body = req.body as {
      name: string
      scopes: string[]
      expiresAt: Date | null
    }

    const generated = generateApiKey()

    const [row] = await db
      .insert(apiKeys)
      .values({
        id: newId(),
        name: body.name,
        prefix: generated.prefix,
        keyHash: generated.hash,
        scopes: body.scopes,
        expiresAt: body.expiresAt,
        createdByUserId: user.id,
      })
      .returning()

    if (!row) {
      throw new NotFoundError("API key")
    }

    await recordActivity({
      userId: user.id,
      action: "created",
      section: "user-management",
      summary: `Created API key ${body.name}`,
      metadata: { scopes: body.scopes },
      ipAddress: req.ip,
    })

    res.status(201).json({
      data: serializeApiKey(row),
      meta: {
        key: generated.token,
        notice: "Copy this key now. It cannot be shown again.",
      },
    })
  }
)

apiKeysRouter.post(
  "/:id/revoke",
  validate({ params: z.object({ id: z.string().min(1) }) }),
  async (req, res) => {
    const { user } = getAuth(req)
    const id = req.params.id as string

    const [row] = await db
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(eq(apiKeys.id, id))
      .returning()

    if (!row) {
      throw new NotFoundError("API key")
    }

    await recordActivity({
      userId: user.id,
      action: "updated",
      section: "user-management",
      summary: `Revoked API key ${row.name}`,
      ipAddress: req.ip,
    })

    res.json({ data: serializeApiKey(row) })
  }
)

apiKeysRouter.delete(
  "/:id",
  validate({ params: z.object({ id: z.string().min(1) }) }),
  async (req, res) => {
    const { user } = getAuth(req)
    const id = req.params.id as string

    const [row] = await db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.id, id))
      .limit(1)

    if (!row) {
      throw new NotFoundError("API key")
    }

    await db.delete(apiKeys).where(eq(apiKeys.id, id))

    await recordActivity({
      userId: user.id,
      action: "deleted",
      section: "user-management",
      summary: `Deleted API key ${row.name}`,
      ipAddress: req.ip,
    })

    res.json({ data: { ok: true } })
  }
)

import { eq } from "drizzle-orm"
import { Router } from "express"
import { z } from "zod"

import { db } from "../db/index.js"
import { discordTriggers } from "../db/schema.js"
import { env } from "../env.js"
import { decryptSecret, encryptSecret } from "../lib/crypto.js"
import { BadRequestError } from "../lib/errors.js"
import { getAuth } from "../middleware/auth.js"
import { validate } from "../middleware/validate.js"
import { recordActivity } from "../services/activity.js"
import {
  DISCORD_TRIGGERS,
  DISCORD_TRIGGER_LABELS,
  isValidDiscordWebhookUrl,
  sendDiscordTestMessage,
  webhookUrlHint,
} from "../services/discord.js"

export const discordRouter: Router = Router()

const triggerParamSchema = z.object({ trigger: z.enum(DISCORD_TRIGGERS) })

/**
 * Webhook URLs are write-only. The response carries a hint and a configured
 * flag so the settings form can show state without ever handing the secret
 * back to the browser.
 */
discordRouter.get("/", async (_req, res) => {
  const rows = await db.select().from(discordTriggers)
  const byTrigger = new Map(rows.map((row) => [row.trigger, row]))

  res.json({
    data: DISCORD_TRIGGERS.map((trigger) => {
      const row = byTrigger.get(trigger)

      return {
        trigger,
        label: DISCORD_TRIGGER_LABELS[trigger],
        enabled: row?.enabled ?? false,
        configured: Boolean(row?.webhookUrlEncrypted),
        webhookUrlHint: row?.webhookUrlHint ?? null,
        lastFiredAt: row?.lastFiredAt?.toISOString() ?? null,
        lastError: row?.lastError ?? null,
      }
    }),
  })
})

discordRouter.put(
  "/:trigger",
  validate({
    params: triggerParamSchema,
    body: z
      .object({
        enabled: z.boolean().optional(),
        // `null` clears the stored URL; omitting it leaves the existing one.
        webhookUrl: z.string().trim().max(500).nullable().optional(),
      })
      .strict()
      .refine((value) => Object.keys(value).length > 0, {
        message: "Provide at least one field to update",
      }),
  }),
  async (req, res) => {
    const { user } = getAuth(req)
    const trigger = req.params.trigger as (typeof DISCORD_TRIGGERS)[number]
    const body = req.body as {
      enabled?: boolean
      webhookUrl?: string | null
    }

    if (body.webhookUrl && !isValidDiscordWebhookUrl(body.webhookUrl)) {
      throw new BadRequestError(
        "Enter a Discord webhook URL that starts with https://discord.com/api/webhooks/"
      )
    }

    const [existing] = await db
      .select()
      .from(discordTriggers)
      .where(eq(discordTriggers.trigger, trigger))
      .limit(1)

    const urlUpdate =
      body.webhookUrl === undefined
        ? {}
        : body.webhookUrl === null
          ? { webhookUrlEncrypted: null, webhookUrlHint: null }
          : {
              webhookUrlEncrypted: encryptSecret(body.webhookUrl),
              webhookUrlHint: webhookUrlHint(body.webhookUrl),
            }

    const willHaveUrl =
      body.webhookUrl === null
        ? false
        : body.webhookUrl !== undefined
          ? true
          : Boolean(existing?.webhookUrlEncrypted)

    if (body.enabled && !willHaveUrl) {
      throw new BadRequestError(
        "Add a webhook URL before enabling this trigger"
      )
    }

    const values = {
      trigger,
      enabled: body.enabled ?? existing?.enabled ?? false,
      ...urlUpdate,
      updatedByUserId: user.id,
      updatedAt: new Date(),
      lastError: null,
    }

    const [row] = await db
      .insert(discordTriggers)
      .values(values)
      .onConflictDoUpdate({ target: discordTriggers.trigger, set: values })
      .returning()

    await recordActivity({
      userId: user.id,
      action: "updated",
      section: "discord",
      summary: `Updated ${DISCORD_TRIGGER_LABELS[trigger]} webhook`,
      ipAddress: req.ip,
    })

    res.json({
      data: {
        trigger,
        label: DISCORD_TRIGGER_LABELS[trigger],
        enabled: row?.enabled ?? false,
        configured: Boolean(row?.webhookUrlEncrypted),
        webhookUrlHint: row?.webhookUrlHint ?? null,
        lastFiredAt: row?.lastFiredAt?.toISOString() ?? null,
        lastError: null,
      },
    })
  }
)

/** Posts a real message so the operator can confirm the URL works. */
discordRouter.post(
  "/:trigger/test",
  validate({
    params: triggerParamSchema,
    body: z
      .object({ webhookUrl: z.string().trim().max(500).optional() })
      .strict()
      .default({}),
  }),
  async (req, res) => {
    const trigger = req.params.trigger as (typeof DISCORD_TRIGGERS)[number]
    const provided = (req.body as { webhookUrl?: string }).webhookUrl

    let url = provided

    if (!url) {
      const [existing] = await db
        .select()
        .from(discordTriggers)
        .where(eq(discordTriggers.trigger, trigger))
        .limit(1)

      if (!existing?.webhookUrlEncrypted) {
        throw new BadRequestError("No webhook URL is configured for this trigger")
      }

      url = decryptSecret(existing.webhookUrlEncrypted)
    }

    const result = await sendDiscordTestMessage(url, env.TENANT_NAME)

    if (!result.ok) {
      throw new BadRequestError(result.error)
    }

    res.json({ data: { ok: true } })
  }
)

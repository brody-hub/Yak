import { eq } from "drizzle-orm"

import { db } from "../db/index.js"
import { discordTriggers } from "../db/schema.js"
import { decryptSecret } from "../lib/crypto.js"
import { logger } from "../logger.js"

export const DISCORD_TRIGGERS = [
  "new_user",
  "new_support",
  "new_subscription",
  "ticket_status_change",
] as const

export type DiscordTriggerId = (typeof DISCORD_TRIGGERS)[number]

export const DISCORD_TRIGGER_LABELS: Record<DiscordTriggerId, string> = {
  new_user: "New user",
  new_support: "New support",
  new_subscription: "New subscription",
  ticket_status_change: "Ticket status change",
}

export function isValidTriggerId(value: string): value is DiscordTriggerId {
  return (DISCORD_TRIGGERS as readonly string[]).includes(value)
}

/**
 * Only genuine Discord webhook endpoints are accepted.
 *
 * This is the SSRF boundary: the URL is operator supplied and this server will
 * make an outbound POST to it, so an arbitrary host would let an admin probe
 * internal network services through us.
 */
export function isValidDiscordWebhookUrl(value: string): boolean {
  let parsed: URL

  try {
    parsed = new URL(value.trim())
  } catch {
    return false
  }

  const host = parsed.hostname.toLowerCase()
  const isDiscordHost =
    host === "discord.com" ||
    host === "discordapp.com" ||
    host.endsWith(".discord.com")

  return (
    parsed.protocol === "https:" &&
    isDiscordHost &&
    parsed.pathname.startsWith("/api/webhooks/")
  )
}

/** Non secret fragment shown in the settings UI in place of the full URL. */
export function webhookUrlHint(value: string): string {
  const trimmed = value.trim()
  const tail = trimmed.slice(-4)

  return `discord.com/api/webhooks/…${tail}`
}

type DiscordEmbed = {
  title: string
  description?: string
  color: number
  fields?: { name: string; value: string; inline?: boolean }[]
  timestamp: string
}

const TRIGGER_COLORS: Record<DiscordTriggerId, number> = {
  new_user: 0x5865f2,
  new_support: 0xf59e0b,
  new_subscription: 0x22c55e,
  ticket_status_change: 0x64748b,
}

export type TriggerPayload = {
  title: string
  description?: string
  fields?: { name: string; value: string; inline?: boolean }[]
}

/**
 * Fires a configured Discord webhook.
 *
 * Fire and forget by design: a Discord outage must never fail the panel action
 * or ingest request that triggered it. Failures are recorded on the trigger row
 * so the settings UI can surface them.
 */
export async function fireDiscordTrigger(
  trigger: DiscordTriggerId,
  payload: TriggerPayload
): Promise<void> {
  try {
    const [config] = await db
      .select()
      .from(discordTriggers)
      .where(eq(discordTriggers.trigger, trigger))
      .limit(1)

    if (!config?.enabled || !config.webhookUrlEncrypted) {
      return
    }

    const url = decryptSecret(config.webhookUrlEncrypted)

    if (!isValidDiscordWebhookUrl(url)) {
      logger.warn({ trigger }, "Stored Discord webhook URL is no longer valid")
      return
    }

    const embed: DiscordEmbed = {
      title: payload.title,
      color: TRIGGER_COLORS[trigger],
      timestamp: new Date().toISOString(),
      ...(payload.description ? { description: payload.description } : {}),
      ...(payload.fields?.length ? { fields: payload.fields } : {}),
    }

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ embeds: [embed] }),
      signal: AbortSignal.timeout(8_000),
    })

    if (!response.ok) {
      const detail = `Discord responded ${response.status}`
      logger.warn({ trigger, status: response.status }, "Discord webhook failed")
      await db
        .update(discordTriggers)
        .set({ lastError: detail })
        .where(eq(discordTriggers.trigger, trigger))
      return
    }

    await db
      .update(discordTriggers)
      .set({ lastFiredAt: new Date(), lastError: null })
      .where(eq(discordTriggers.trigger, trigger))
  } catch (error) {
    logger.warn({ err: error, trigger }, "Discord trigger dispatch failed")

    await db
      .update(discordTriggers)
      .set({
        lastError:
          error instanceof Error ? error.message : "Unknown dispatch error",
      })
      .where(eq(discordTriggers.trigger, trigger))
      .catch(() => undefined)
  }
}

/** Sends a one-off message so an operator can verify their URL works. */
export async function sendDiscordTestMessage(
  url: string,
  tenantName: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!isValidDiscordWebhookUrl(url)) {
    return { ok: false, error: "That is not a valid Discord webhook URL" }
  }

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        embeds: [
          {
            title: "Webhook connected",
            description: `${tenantName} will post notifications here.`,
            color: 0x22c55e,
            timestamp: new Date().toISOString(),
          },
        ],
      }),
      signal: AbortSignal.timeout(8_000),
    })

    if (!response.ok) {
      return { ok: false, error: `Discord responded ${response.status}` }
    }

    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Could not reach Discord",
    }
  }
}

import { eq } from "drizzle-orm"
import { Router } from "express"
import { z } from "zod"

import { canManageUsers } from "../auth/permissions.js"
import { db } from "../db/index.js"
import { providerIntegrations } from "../db/schema.js"
import { decryptSecret, encryptSecret } from "../lib/crypto.js"
import { NotFoundError } from "../lib/errors.js"
import { getAuth } from "../middleware/auth.js"
import { requireApiKeyManagement } from "../middleware/permissions.js"
import { validate } from "../middleware/validate.js"
import { recordActivity } from "../services/activity.js"
import {
  apiKeyHint,
  clearRevenueCatCache,
  fetchOverview,
  resolveProject,
} from "../services/revenuecat.js"

export const integrationsRouter: Router = Router()

/* -------------------------------------------------------------------------- */
/* Provider catalogue                                                          */
/* -------------------------------------------------------------------------- */

const PROVIDERS = [
  {
    id: "revenuecat" as const,
    label: "RevenueCat",
    /** Capabilities the panel unlocks once this provider is connected. */
    capabilities: ["subscription-metrics", "revenue-metrics"],
  },
]

type IntegrationStatus = {
  provider: "revenuecat"
  label: string
  capabilities: string[]
  connected: boolean
  /** Present only for owners and admins; never the key itself. */
  apiKeyHint: string | null
  projectId: string | null
  projectName: string | null
  connectedAt: string | null
  lastCheckedAt: string | null
  lastError: string | null
}

type IntegrationRow = typeof providerIntegrations.$inferSelect

/**
 * `privileged` gates everything that is only useful to an operator. Members need
 * the `connected` flag so the dashboard knows which widgets can produce data,
 * but they have no reason to see the key hint or the provider side project.
 */
function buildStatus(
  provider: (typeof PROVIDERS)[number],
  row: IntegrationRow | undefined,
  privileged: boolean
): IntegrationStatus {
  return {
    provider: provider.id,
    label: provider.label,
    capabilities: provider.capabilities,
    connected: Boolean(row?.externalId),
    apiKeyHint: privileged ? (row?.apiKeyHint ?? null) : null,
    projectId: privileged ? (row?.externalId ?? null) : null,
    projectName: privileged ? (row?.externalName ?? null) : null,
    connectedAt: row?.connectedAt?.toISOString() ?? null,
    lastCheckedAt: row?.lastCheckedAt?.toISOString() ?? null,
    lastError: privileged ? (row?.lastError ?? null) : null,
  }
}

/** Connection state for every provider. Readable by any signed-in user. */
integrationsRouter.get("/", async (req, res) => {
  const auth = getAuth(req)
  const privileged = canManageUsers(auth.user)

  const rows = await db.select().from(providerIntegrations)
  const byProvider = new Map(rows.map((row) => [row.provider, row]))

  res.json({
    data: PROVIDERS.map((provider) =>
      buildStatus(provider, byProvider.get(provider.id), privileged)
    ),
  })
})

/* -------------------------------------------------------------------------- */
/* RevenueCat                                                                  */
/* -------------------------------------------------------------------------- */

async function loadRevenueCatRow(): Promise<IntegrationRow | undefined> {
  const [row] = await db
    .select()
    .from(providerIntegrations)
    .where(eq(providerIntegrations.provider, "revenuecat"))
    .limit(1)

  return row
}

async function revenueCatStatus(): Promise<IntegrationStatus> {
  return buildStatus(PROVIDERS[0]!, await loadRevenueCatRow(), true)
}

/**
 * Stores a RevenueCat secret key.
 *
 * The key is verified against RevenueCat before it is written, so a typo is
 * reported immediately instead of silently breaking every KPI tile. Only the
 * ciphertext and a short hint are persisted — there is no endpoint anywhere that
 * returns the key, and the only way to change it is to replace it.
 */
integrationsRouter.put(
  "/revenuecat",
  requireApiKeyManagement,
  validate({
    body: z
      .object({
        apiKey: z.string().trim().min(10).max(300),
        // Optional: an account with several projects can pin a specific one.
        projectId: z.string().trim().max(120).optional(),
      })
      .strict(),
  }),
  async (req, res) => {
    const { user } = getAuth(req)
    const body = req.body as { apiKey: string; projectId?: string }

    const project = await resolveProject(body.apiKey, body.projectId)

    const values = {
      provider: "revenuecat" as const,
      apiKeyEncrypted: encryptSecret(body.apiKey),
      apiKeyHint: apiKeyHint(body.apiKey),
      externalId: project.id,
      externalName: project.name,
      lastCheckedAt: new Date(),
      lastError: null,
      connectedByUserId: user.id,
      connectedAt: new Date(),
      updatedAt: new Date(),
    }

    await db
      .insert(providerIntegrations)
      .values(values)
      .onConflictDoUpdate({
        target: providerIntegrations.provider,
        set: values,
      })

    clearRevenueCatCache()

    await recordActivity({
      userId: user.id,
      action: "updated",
      section: "integrations",
      summary: `Connected RevenueCat project ${project.name}`,
      ipAddress: req.ip,
    })

    res.json({ data: await revenueCatStatus() })
  }
)

/** Confirms the stored key still works. */
integrationsRouter.post(
  "/revenuecat/test",
  requireApiKeyManagement,
  async (req, res) => {
    const { user } = getAuth(req)
    const row = await loadRevenueCatRow()

    if (!row?.externalId) {
      throw new NotFoundError("RevenueCat connection")
    }

    clearRevenueCatCache()

    try {
      const overview = await fetchOverview({
        apiKey: decryptSecret(row.apiKeyEncrypted),
        projectId: row.externalId,
      })

      await db
        .update(providerIntegrations)
        .set({ lastCheckedAt: new Date(), lastError: null })
        .where(eq(providerIntegrations.provider, "revenuecat"))

      res.json({
        data: {
          ok: true,
          metricsAvailable: overview.metrics.length,
          currency: overview.currency,
        },
      })
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "RevenueCat check failed"

      await db
        .update(providerIntegrations)
        .set({ lastCheckedAt: new Date(), lastError: message })
        .where(eq(providerIntegrations.provider, "revenuecat"))

      // Recorded against the connection so the settings page can explain the
      // failure the next time it loads, then rethrown for the caller.
      await recordActivity({
        userId: user.id,
        action: "updated",
        section: "integrations",
        summary: `RevenueCat check failed: ${message}`,
        ipAddress: req.ip,
      })

      throw error
    }
  }
)

/** Deletes the stored credential outright; there is nothing to recover. */
integrationsRouter.delete(
  "/revenuecat",
  requireApiKeyManagement,
  async (req, res) => {
    const { user } = getAuth(req)

    const deleted = await db
      .delete(providerIntegrations)
      .where(eq(providerIntegrations.provider, "revenuecat"))
      .returning()

    clearRevenueCatCache()

    if (deleted.length > 0) {
      await recordActivity({
        userId: user.id,
        action: "deleted",
        section: "integrations",
        summary: "Removed the RevenueCat connection",
        ipAddress: req.ip,
      })
    }

    res.json({ data: await revenueCatStatus() })
  }
)

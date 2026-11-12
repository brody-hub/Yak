import { and, eq } from "drizzle-orm"
import { Router } from "express"
import { z } from "zod"

import { canManageUsers } from "../auth/permissions.js"
import { db } from "../db/index.js"
import { providerIntegrations } from "../db/schema.js"
import { decryptSecret, encryptSecret } from "../lib/crypto.js"
import { NotFoundError } from "../lib/errors.js"
import { getAuth, getScope, getTenantId } from "../middleware/auth.js"
import { requireApiKeyManagement } from "../middleware/permissions.js"
import { validate } from "../middleware/validate.js"
import { recordActivity } from "../services/activity.js"
import { loadConnection as loadSideshiftConnection } from "../services/sideshift/connection.js"
import {
  apiKeyHint,
  clearRevenueCatCache,
  fetchOverview,
  resolveProject,
  revenueCatBinding,
} from "../services/revenuecat.js"

/**
 * Mounted under /apps/:appId. RevenueCat is connected per app; Sideshift is an
 * account-level connection that is listed here so widgets can see it.
 */
export const integrationsRouter: Router = Router({ mergeParams: true })

type Scope = { tenantId: string; appId: string }

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
  provider: "revenuecat" | "sideshift"
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
  const tenantId = getTenantId(req)
  const scope = getScope(req)

  const rows = await db
    .select()
    .from(providerIntegrations)
    .where(
      and(
        eq(providerIntegrations.tenantId, scope.tenantId),
        eq(providerIntegrations.appId, scope.appId)
      )
    )
  const byProvider = new Map(rows.map((row) => [row.provider, row]))

  res.json({
    data: [
      ...PROVIDERS.map((provider) =>
        buildStatus(provider, byProvider.get(provider.id), privileged)
      ),
      await sideshiftIntegrationStatus(tenantId, privileged),
    ],
  })
})

/**
 * Sideshift connects over OAuth (see routes/sideshift.ts), so it has no key or
 * hint. It is listed here so dashboard widgets can tell whether campaign data
 * exists. A connection that needs reconnecting still counts as connected:
 * its cached data is still there to show.
 */
async function sideshiftIntegrationStatus(
  tenantId: string,
  privileged: boolean
): Promise<IntegrationStatus> {
  const row = await loadSideshiftConnection(tenantId)
  const connected = Boolean(row && row.status !== "disconnected")

  return {
    provider: "sideshift",
    label: "Sideshift",
    capabilities: ["campaign-analytics"],
    connected,
    apiKeyHint: null,
    projectId: privileged && connected ? (row?.companyId ?? null) : null,
    projectName: privileged && connected ? (row?.companyName ?? null) : null,
    connectedAt: row?.connectedAt?.toISOString() ?? null,
    lastCheckedAt: row?.lastSyncedAt?.toISOString() ?? null,
    lastError: privileged ? (row?.lastError ?? null) : null,
  }
}

/* -------------------------------------------------------------------------- */
/* RevenueCat                                                                  */
/* -------------------------------------------------------------------------- */

function revenueCatRow(scope: Scope) {
  return and(
    eq(providerIntegrations.tenantId, scope.tenantId),
    eq(providerIntegrations.appId, scope.appId),
    eq(providerIntegrations.provider, "revenuecat")
  )
}

async function loadRevenueCatRow(
  scope: Scope
): Promise<IntegrationRow | undefined> {
  const [row] = await db
    .select()
    .from(providerIntegrations)
    .where(revenueCatRow(scope))
    .limit(1)

  return row
}

async function revenueCatStatus(scope: Scope): Promise<IntegrationStatus> {
  return buildStatus(PROVIDERS[0]!, await loadRevenueCatRow(scope), true)
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
    const scope = getScope(req)
    const { tenantId, appId } = scope
    const body = req.body as { apiKey: string; projectId?: string }

    const project = await resolveProject(body.apiKey, body.projectId)

    const values = {
      tenantId,
      appId,
      provider: "revenuecat" as const,
      apiKeyEncrypted: encryptSecret(
        body.apiKey,
        revenueCatBinding(tenantId, appId)
      ),
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
        target: [
          providerIntegrations.tenantId,
          providerIntegrations.appId,
          providerIntegrations.provider,
        ],
        set: values,
      })

    clearRevenueCatCache(tenantId, appId)

    await recordActivity({
      tenantId,
      userId: user.id,
      action: "updated",
      section: "integrations",
      summary: `Connected RevenueCat project ${project.name} to ${req.currentApp!.name}`,
      metadata: { appId },
      ipAddress: req.ip,
    })

    res.json({ data: await revenueCatStatus(scope) })
  }
)

/** Confirms the stored key still works. */
integrationsRouter.post(
  "/revenuecat/test",
  requireApiKeyManagement,
  async (req, res) => {
    const { user } = getAuth(req)
    const scope = getScope(req)
    const { tenantId, appId } = scope
    const row = await loadRevenueCatRow(scope)

    if (!row?.externalId) {
      throw new NotFoundError("RevenueCat connection")
    }

    clearRevenueCatCache(tenantId, appId)

    try {
      const overview = await fetchOverview({
        tenantId,
        appId,
        apiKey: decryptSecret(
          row.apiKeyEncrypted,
          revenueCatBinding(tenantId, appId)
        ),
        projectId: row.externalId,
      })

      await db
        .update(providerIntegrations)
        .set({ lastCheckedAt: new Date(), lastError: null })
        .where(revenueCatRow(scope))

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
        .where(revenueCatRow(scope))

      // Recorded against the connection so the settings page can explain the
      // failure the next time it loads, then rethrown for the caller.
      await recordActivity({
        tenantId,
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
    const scope = getScope(req)
    const { tenantId, appId } = scope

    const deleted = await db
      .delete(providerIntegrations)
      .where(revenueCatRow(scope))
      .returning()

    clearRevenueCatCache(tenantId, appId)

    if (deleted.length > 0) {
      await recordActivity({
        tenantId,
        userId: user.id,
        action: "deleted",
        section: "integrations",
        summary: `Removed the RevenueCat connection from ${req.currentApp!.name}`,
        metadata: { appId },
        ipAddress: req.ip,
      })
    }

    res.json({ data: await revenueCatStatus(scope) })
  }
)

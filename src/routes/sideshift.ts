import { and, eq, isNotNull, isNull } from "drizzle-orm"
import { Router } from "express"
import { z } from "zod"

import { canManageUsers } from "../auth/permissions.js"
import { db } from "../db/index.js"
import { sideshiftCampaigns, sideshiftConnection } from "../db/schema.js"
import { withLookupScope, withTenantScope } from "../db/scope.js"
import { env } from "../env.js"
import {
  decryptSecret,
  encryptSecret,
  safeEqual,
  sha256,
} from "../lib/crypto.js"
import {
  ConflictError,
  NotFoundError,
  RateLimitError,
  ServiceUnavailableError,
  ValidationError,
} from "../lib/errors.js"
import { logger } from "../logger.js"
import { getAuth, getTenantId } from "../middleware/auth.js"
import { requireApiKeyManagement } from "../middleware/permissions.js"
import { validate, validatedQuery } from "../middleware/validate.js"
import { recordActivity } from "../services/activity.js"
import {
  campaignAnalytics,
  campaignSeries,
  SERIES_MAX_CREATORS,
  SERIES_MAX_DAYS,
  sideshiftStatus,
  type AnalyticsRange,
  type PostSort,
} from "../services/sideshift/analytics.js"
import {
  SIDESHIFT_ISSUER,
  SideshiftError,
} from "../services/sideshift/client.js"
import {
  clientCredentials,
  ensureConnection,
  findConnectionByStateHash,
  loadConnection,
  saveTokens,
  updateConnection,
  withSideshiftLock,
  sideshiftBinding,
} from "../services/sideshift/connection.js"
import {
  callbackUrl,
  createAuthorization,
  exchangeCode,
  registerClient,
  revokeRefreshToken,
} from "../services/sideshift/oauth.js"
import {
  canRefreshNow,
  clearSideshiftCache,
  startSync,
  trackCampaigns,
  untrackCampaigns,
} from "../services/sideshift/sync.js"
import { loadTenant } from "../services/tenants.js"

/**
 * Sideshift campaign analytics for the Marketing tab.
 *
 * Reading is open to anyone with the `marketing` section. Connecting,
 * disconnecting and choosing campaigns are owner/admin only, matching the
 * RevenueCat integration. Reads never wait on Sideshift: they answer from the
 * local copy and start a background sync when the last one is over an hour old.
 */

export const sideshiftRouter: Router = Router()

/** How long a Connect click stays valid before the callback is refused. */
const AUTHORIZATION_TTL_MS = 15 * 60_000
/** How long connect/disconnect wait for a running sync to finish. */
const LOCK_WAIT_MS = 30_000

const DISCONNECTED_VALUES = {
  status: "disconnected" as const,
  accessTokenEncrypted: null,
  accessTokenExpiresAt: null,
  refreshTokenEncrypted: null,
  scope: null,
  companyId: null,
  companyName: null,
  connectedAt: null,
  connectedByUserId: null,
  syncStartedAt: null,
  lastSyncedAt: null,
  lastError: null,
  lastErrorAt: null,
  lastErrorRequestId: null,
  oauthStateHash: null,
  oauthVerifierEncrypted: null,
  oauthStartedAt: null,
  oauthStartedByUserId: null,
  oauthCodeEncrypted: null,
}

function startSyncIfDue(tenantId: string, status: string) {
  if (status === "connected") {
    startSync(tenantId, "auto")
  }
}

sideshiftRouter.get("/status", async (req, res) => {
  const tenantId = getTenantId(req)
  const data = await sideshiftStatus(tenantId, {
    privileged: canManageUsers(getAuth(req).user),
  })

  startSyncIfDue(tenantId, data.status)
  res.json({ data })
})

sideshiftRouter.get(
  "/analytics",
  validate({
    query: z.object({
      campaign: z.string().trim().min(1).max(240).default("all"),
      range: z.enum(["7d", "30d", "all"]).default("30d"),
      sort: z.enum(["views", "newest"]).default("views"),
    }),
  }),
  async (req, res) => {
    const query = validatedQuery<{
      campaign: string
      range: AnalyticsRange
      sort: PostSort
    }>(req)
    const tenantId = getTenantId(req)
    const row = await loadConnection(tenantId)

    if (!row || row.status === "disconnected") {
      throw new NotFoundError("Sideshift connection")
    }

    startSyncIfDue(tenantId, row.status)

    res.json({
      data: await campaignAnalytics({
        tenantId,
        campaign: query.campaign,
        range: query.range,
        postSort: query.sort,
      }),
    })
  }
)

/**
 * Daily views for the dashboard's views-vs-revenue tile. `creators` is a
 * comma-separated list of creator keys from `/analytics`, each URI-encoded so
 * a handle with a comma survives the trip.
 */
sideshiftRouter.get(
  "/series",
  validate({
    query: z.object({
      campaign: z.string().trim().min(1).max(240).default("all"),
      days: z.coerce.number().int().min(7).max(SERIES_MAX_DAYS).default(30),
      creators: z
        .string()
        .max(4000)
        .default("")
        .transform((value) =>
          Array.from(
            new Set(
              value
                .split(",")
                .map((entry) => entry.trim())
                .filter(Boolean)
                .map((entry) => {
                  try {
                    return decodeURIComponent(entry)
                  } catch {
                    return entry
                  }
                })
            )
          )
        )
        .pipe(z.array(z.string().min(1).max(240)).max(SERIES_MAX_CREATORS)),
    }),
  }),
  async (req, res) => {
    const query = validatedQuery<{
      campaign: string
      days: number
      creators: string[]
    }>(req)
    const tenantId = getTenantId(req)
    const row = await loadConnection(tenantId)

    if (!row || row.status === "disconnected") {
      throw new NotFoundError("Sideshift connection")
    }

    startSyncIfDue(tenantId, row.status)

    res.json({ data: await campaignSeries({ tenantId, ...query }) })
  }
)

/** The Refresh button. Answers at once; the page polls status for the result. */
sideshiftRouter.post("/refresh", async (req, res) => {
  const tenantId = getTenantId(req)
  const row = await loadConnection(tenantId)

  if (!row || row.status === "disconnected") {
    throw new NotFoundError("Sideshift connection")
  }

  if (row.status === "needs_reconnect") {
    throw new ConflictError("Reconnect Sideshift before refreshing")
  }

  if (!canRefreshNow(row)) {
    throw new RateLimitError("Synced moments ago. Try again in a minute.")
  }

  startSync(tenantId, "manual")
  res.status(202).json({ data: { started: true } })
})

/** Replaces the set of tracked campaigns. */
sideshiftRouter.put(
  "/campaigns",
  requireApiKeyManagement,
  validate({
    body: z
      .object({ tracked: z.array(z.string().trim().min(1).max(240)).max(500) })
      .strict(),
  }),
  async (req, res) => {
    const { user } = getAuth(req)
    const tenantId = getTenantId(req)
    const wanted = new Set((req.body as { tracked: string[] }).tracked)

    // Only this tenant's campaigns are known, so an id from another tenant is
    // rejected as unknown below.
    const campaigns = await db
      .select()
      .from(sideshiftCampaigns)
      .where(
        and(
          eq(sideshiftCampaigns.tenantId, tenantId),
          isNull(sideshiftCampaigns.removedAt)
        )
      )
    const known = new Set(campaigns.map((campaign) => campaign.id))
    const unknown = [...wanted].filter((id) => !known.has(id))

    if (unknown.length > 0) {
      throw new ValidationError(
        [{ field: "tracked", message: "Unknown campaign" }],
        "Some campaigns no longer exist in Sideshift"
      )
    }

    const toTrack = campaigns
      .filter((campaign) => wanted.has(campaign.id) && !campaign.tracked)
      .map((campaign) => campaign.id)
    const toUntrack = campaigns
      .filter((campaign) => !wanted.has(campaign.id) && campaign.tracked)
      .map((campaign) => campaign.id)

    await untrackCampaigns(tenantId, toUntrack)
    await trackCampaigns(tenantId, toTrack)

    if (toTrack.length > 0) {
      startSync(tenantId, "immediate")
    }

    if (toTrack.length > 0 || toUntrack.length > 0) {
      await recordActivity({
        tenantId,
        userId: user.id,
        action: "updated",
        section: "integrations",
        summary: `Now tracking ${wanted.size} Sideshift campaign${wanted.size === 1 ? "" : "s"}`,
        ipAddress: req.ip,
      })
    }

    res.json({ data: await sideshiftStatus(tenantId, { privileged: true }) })
  }
)

/**
 * Starts the OAuth flow. Registers the tenant's connection with Sideshift the
 * first time, or again when the API's public URL changed, then hands the panel
 * the consent URL to navigate to.
 */
sideshiftRouter.post("/connect", requireApiKeyManagement, async (req, res) => {
  const { user } = getAuth(req)
  const tenantId = getTenantId(req)
  const redirectUri = callbackUrl()
  let row = await ensureConnection(tenantId)

  if (!row.clientId || row.redirectUri !== redirectUri) {
    try {
      const tenant = await loadTenant(tenantId)
      const client = await registerClient(redirectUri, tenant.name)

      await updateConnection(tenantId, {
        clientId: client.clientId,
        clientSecretEncrypted: encryptSecret(
          client.clientSecret,
          sideshiftBinding(tenantId)
        ),
        registrationAccessTokenEncrypted: client.registrationAccessToken
          ? encryptSecret(
              client.registrationAccessToken,
              sideshiftBinding(tenantId)
            )
          : null,
        redirectUri,
      })
    } catch (error) {
      logger.error(
        {
          err: error instanceof SideshiftError ? undefined : error,
          code: error instanceof SideshiftError ? error.code : undefined,
          requestId:
            error instanceof SideshiftError ? error.requestId : undefined,
          tenantId,
        },
        "Sideshift client registration failed"
      )
      throw new ServiceUnavailableError(
        "Could not register with Sideshift. Try again in a few minutes."
      )
    }

    row = (await loadConnection(tenantId))!
  }

  const authorization = createAuthorization({
    clientId: row.clientId!,
    redirectUri,
  })

  await updateConnection(tenantId, {
    oauthStateHash: sha256(authorization.state),
    oauthVerifierEncrypted: encryptSecret(
      authorization.verifier,
      sideshiftBinding(tenantId)
    ),
    oauthStartedAt: new Date(),
    oauthStartedByUserId: user.id,
    // A new Connect click supersedes any code still waiting from an old one.
    oauthCodeEncrypted: null,
  })

  res.json({ data: { authorizeUrl: authorization.url } })
})

/**
 * Revokes the token on Sideshift's side, then forgets the connection and every
 * cached row. The OAuth client registration is kept for the next connect.
 */
sideshiftRouter.delete(
  "/connection",
  requireApiKeyManagement,
  async (req, res) => {
    const { user } = getAuth(req)
    const tenantId = getTenantId(req)

    const outcome = await withSideshiftLock(
      tenantId,
      async () => {
        const row = await loadConnection(tenantId)

        if (row?.refreshTokenEncrypted && row.clientId) {
          try {
            await revokeRefreshToken(
              clientCredentials(row),
              decryptSecret(
                row.refreshTokenEncrypted,
                sideshiftBinding(tenantId)
              )
            )
          } catch (error) {
            // Still disconnect locally. The token is forgotten either way and
            // the founder can remove Yak from Sideshift's own settings.
            logger.warn(
              { err: error, tenantId },
              "Could not revoke the Sideshift token"
            )
          }
        }

        await updateConnection(tenantId, DISCONNECTED_VALUES)
        await clearSideshiftCache(tenantId)
      },
      { waitMs: LOCK_WAIT_MS }
    )

    if (!outcome.acquired) {
      throw new ConflictError("A sync is running. Try again in a minute.")
    }

    await recordActivity({
      tenantId,
      userId: user.id,
      action: "deleted",
      section: "integrations",
      summary: "Disconnected Sideshift",
      ipAddress: req.ip,
    })

    res.json({ data: await sideshiftStatus(tenantId, { privileged: true }) })
  }
)

/* -------------------------------------------------------------------------- */
/* OAuth callback and confirmation                                             */
/* -------------------------------------------------------------------------- */

const PENDING_OAUTH_CLEARED = {
  oauthStateHash: null,
  oauthVerifierEncrypted: null,
  oauthStartedAt: null,
  oauthStartedByUserId: null,
  oauthCodeEncrypted: null,
}

/**
 * Where Sideshift sends the browser after consent. Mounted outside the session
 * guard because the session cookie does not reliably reach this host on a
 * top-level navigation (it is partitioned to the panel in production).
 *
 * It does not finish the connection. The code is only parked on the
 * connection and the browser goes back to the panel, where the user who
 * clicked Connect confirms with a click through POST /sideshift/complete from
 * their own session. So a link opened by anyone else connects nothing to their
 * account, and nobody can be made to connect an account by a link alone.
 *
 * What OAuth itself cannot stop: whoever clicked Connect can forward their
 * consent link to a Sideshift user elsewhere. Sideshift's consent screen names
 * the requesting workspace, which is the safeguard there.
 */
export const sideshiftCallbackRouter: Router = Router()

sideshiftCallbackRouter.get("/sideshift/callback", async (req, res) => {
  const back = (outcome: string) =>
    res.redirect(303, `${env.APP_URL}/marketing?sideshift=${outcome}`)
  const param = (name: string) => {
    const value = req.query[name]
    return typeof value === "string" ? value : null
  }

  // The state is the only thing tying this request to a tenant: the pending
  // authorization that holds its hash says whose connection this is. The
  // request has no session and so no database scope; the lookup scope is the
  // one way to find the row before its tenant is known, and everything after
  // runs in that tenant's scope.
  const state = param("state")
  const row = state
    ? await withLookupScope(() => findConnectionByStateHash(sha256(state)))
    : undefined

  if (
    !state ||
    !row?.oauthStateHash ||
    !row.oauthVerifierEncrypted ||
    // A second visit with the same state is a replay.
    row.oauthCodeEncrypted ||
    !safeEqual(sha256(state), row.oauthStateHash)
  ) {
    back("invalid_state")
    return
  }

  const tenantId = row.tenantId
  const expired =
    !row.oauthStartedAt ||
    Date.now() - row.oauthStartedAt.getTime() > AUTHORIZATION_TTL_MS

  const fail = async (outcome: string) => {
    await withTenantScope(tenantId, () =>
      updateConnection(tenantId, PENDING_OAUTH_CLEARED)
    )
    back(outcome)
  }

  if (expired) {
    await fail("expired")
    return
  }

  const error = param("error")

  if (error) {
    await fail(error === "access_denied" ? "denied" : "error")
    return
  }

  // RFC 9207: the issuer must be Sideshift's when it says who it is.
  const issuer = param("iss")
  const code = param("code")

  if ((issuer && issuer !== SIDESHIFT_ISSUER) || !code) {
    await fail("error")
    return
  }

  // Compare-and-set, so two racing callbacks with the same state cannot both
  // park a code.
  const parked = await withTenantScope(tenantId, (scoped) =>
    scoped
      .update(sideshiftConnection)
      .set({
        oauthCodeEncrypted: encryptSecret(code, sideshiftBinding(tenantId)),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(sideshiftConnection.tenantId, tenantId),
          eq(sideshiftConnection.oauthStateHash, sha256(state)),
          isNull(sideshiftConnection.oauthCodeEncrypted)
        )
      )
      .returning({ tenantId: sideshiftConnection.tenantId })
  )

  if (parked.length === 0) {
    back("invalid_state")
    return
  }

  res.redirect(
    303,
    `${env.APP_URL}/marketing?sideshift=confirm&sideshift_state=${encodeURIComponent(state)}`
  )
})

/**
 * Finishes a connection the callback parked. Only the user who clicked Connect,
 * signed in to the same tenant, can do this.
 *
 * Always answers 200 with an `outcome` the Marketing tab already knows how to
 * show, except when the request is not valid at all.
 */
sideshiftRouter.post(
  "/complete",
  requireApiKeyManagement,
  validate({
    body: z.object({ state: z.string().min(1).max(512) }).strict(),
  }),
  async (req, res) => {
    const { user } = getAuth(req)
    const tenantId = getTenantId(req)
    const { state } = req.body as { state: string }

    // Claim and clear the pending authorization in one statement: it only
    // matches this tenant, this state, the user who clicked Connect, and a
    // code the callback parked. Single use, and safe against a double submit.
    const [row] = await db
      .update(sideshiftConnection)
      .set({ ...PENDING_OAUTH_CLEARED, updatedAt: new Date() })
      .where(
        and(
          eq(sideshiftConnection.tenantId, tenantId),
          eq(sideshiftConnection.oauthStateHash, sha256(state)),
          eq(sideshiftConnection.oauthStartedByUserId, user.id),
          isNotNull(sideshiftConnection.oauthCodeEncrypted),
          isNotNull(sideshiftConnection.oauthVerifierEncrypted)
        )
      )
      .returning({
        verifier: sideshiftConnection.oauthVerifierEncrypted,
        code: sideshiftConnection.oauthCodeEncrypted,
        startedAt: sideshiftConnection.oauthStartedAt,
      })

    if (!row?.verifier || !row.code) {
      throw new ValidationError(
        "This Sideshift connection request is not valid. Click Connect again."
      )
    }

    const verifier = decryptSecret(row.verifier, sideshiftBinding(tenantId))
    const code = decryptSecret(row.code, sideshiftBinding(tenantId))
    const expired =
      !row.startedAt ||
      Date.now() - row.startedAt.getTime() > AUTHORIZATION_TTL_MS

    if (expired) {
      res.json({ data: { outcome: "expired" } })
      return
    }

    // A suspended account never reaches here (requireTenantUser), but this
    // also covers a suspension that landed mid-flow.
    const tenant = await loadTenant(tenantId)

    if (tenant.status !== "active") {
      res.json({ data: { outcome: "error" } })
      return
    }

    try {
      const outcome = await withSideshiftLock(
        tenantId,
        async () => {
          const current = (await loadConnection(tenantId))!
          const client = clientCredentials(current)
          const tokens = await exchangeCode(client, {
            code,
            verifier,
            redirectUri: current.redirectUri ?? callbackUrl(),
          })

          // Reconnecting replaces an older grant. Retire it so it cannot linger.
          if (current.refreshTokenEncrypted) {
            await revokeRefreshToken(
              client,
              decryptSecret(
                current.refreshTokenEncrypted,
                sideshiftBinding(tenantId)
              )
            ).catch((revokeError: unknown) => {
              logger.warn(
                { err: revokeError, tenantId },
                "Could not revoke the old Sideshift token"
              )
            })
          }

          const switchedCompany =
            Boolean(current.companyId && tokens.company.id) &&
            current.companyId !== tokens.company.id

          if (switchedCompany) {
            await clearSideshiftCache(tenantId)
          }

          await saveTokens(tenantId, tokens)
          await updateConnection(tenantId, {
            status: "connected",
            companyId: tokens.company.id,
            companyName: tokens.company.name,
            connectedAt: new Date(),
            connectedByUserId: user.id,
            syncStartedAt: null,
            lastError: null,
            lastErrorAt: null,
            lastErrorRequestId: null,
          })
        },
        { waitMs: LOCK_WAIT_MS }
      )

      if (!outcome.acquired) {
        res.json({ data: { outcome: "busy" } })
        return
      }
    } catch (exchangeError) {
      logger.error(
        {
          err:
            exchangeError instanceof SideshiftError ? undefined : exchangeError,
          code:
            exchangeError instanceof SideshiftError
              ? exchangeError.code
              : undefined,
          requestId:
            exchangeError instanceof SideshiftError
              ? exchangeError.requestId
              : undefined,
          tenantId,
        },
        "Sideshift token exchange failed"
      )
      res.json({ data: { outcome: "error" } })
      return
    }

    await recordActivity({
      tenantId,
      userId: user.id,
      action: "updated",
      section: "integrations",
      summary: "Connected Sideshift",
      ipAddress: req.ip,
    })

    startSync(tenantId, "immediate")
    res.json({ data: { outcome: "connected" } })
  }
)

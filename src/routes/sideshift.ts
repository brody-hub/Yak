import { isNull } from "drizzle-orm"
import { Router } from "express"
import { z } from "zod"

import { canManageUsers } from "../auth/permissions.js"
import { db } from "../db/index.js"
import { sideshiftCampaigns } from "../db/schema.js"
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
import { getAuth } from "../middleware/auth.js"
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
import { SIDESHIFT_ISSUER, SideshiftError } from "../services/sideshift/client.js"
import {
  clientCredentials,
  ensureConnection,
  loadConnection,
  saveTokens,
  updateConnection,
  withSideshiftLock,
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
}

function startSyncIfDue(status: string) {
  if (status === "connected") {
    startSync("auto")
  }
}

sideshiftRouter.get("/status", async (req, res) => {
  const data = await sideshiftStatus({
    privileged: canManageUsers(getAuth(req).user),
  })

  startSyncIfDue(data.status)
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
    const row = await loadConnection()

    if (!row || row.status === "disconnected") {
      throw new NotFoundError("Sideshift connection")
    }

    startSyncIfDue(row.status)

    res.json({
      data: await campaignAnalytics({
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
    const row = await loadConnection()

    if (!row || row.status === "disconnected") {
      throw new NotFoundError("Sideshift connection")
    }

    startSyncIfDue(row.status)

    res.json({ data: await campaignSeries(query) })
  }
)

/** The Refresh button. Answers at once; the page polls status for the result. */
sideshiftRouter.post("/refresh", async (_req, res) => {
  const row = await loadConnection()

  if (!row || row.status === "disconnected") {
    throw new NotFoundError("Sideshift connection")
  }

  if (row.status === "needs_reconnect") {
    throw new ConflictError("Reconnect Sideshift before refreshing")
  }

  if (!canRefreshNow(row)) {
    throw new RateLimitError("Synced moments ago. Try again in a minute.")
  }

  startSync("manual")
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
    const wanted = new Set((req.body as { tracked: string[] }).tracked)

    const campaigns = await db
      .select()
      .from(sideshiftCampaigns)
      .where(isNull(sideshiftCampaigns.removedAt))
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

    await untrackCampaigns(toUntrack)
    await trackCampaigns(toTrack)

    if (toTrack.length > 0) {
      startSync("immediate")
    }

    if (toTrack.length > 0 || toUntrack.length > 0) {
      await recordActivity({
        userId: user.id,
        action: "updated",
        section: "integrations",
        summary: `Now tracking ${wanted.size} Sideshift campaign${wanted.size === 1 ? "" : "s"}`,
        ipAddress: req.ip,
      })
    }

    res.json({ data: await sideshiftStatus({ privileged: true }) })
  }
)

/**
 * Starts the OAuth flow. Registers this deployment with Sideshift the first
 * time, or again when the API's public URL changed, then hands the panel the
 * consent URL to navigate to.
 */
sideshiftRouter.post("/connect", requireApiKeyManagement, async (req, res) => {
  const { user } = getAuth(req)
  const redirectUri = callbackUrl()
  let row = await ensureConnection()

  if (!row.clientId || row.redirectUri !== redirectUri) {
    try {
      const client = await registerClient(redirectUri)

      await updateConnection({
        clientId: client.clientId,
        clientSecretEncrypted: encryptSecret(client.clientSecret),
        registrationAccessTokenEncrypted: client.registrationAccessToken
          ? encryptSecret(client.registrationAccessToken)
          : null,
        redirectUri,
      })
    } catch (error) {
      logger.error(
        {
          err: error instanceof SideshiftError ? undefined : error,
          code: error instanceof SideshiftError ? error.code : undefined,
          requestId: error instanceof SideshiftError ? error.requestId : undefined,
        },
        "Sideshift client registration failed"
      )
      throw new ServiceUnavailableError(
        "Could not register with Sideshift. Try again in a few minutes."
      )
    }

    row = (await loadConnection())!
  }

  const authorization = createAuthorization({
    clientId: row.clientId!,
    redirectUri,
  })

  await updateConnection({
    oauthStateHash: sha256(authorization.state),
    oauthVerifierEncrypted: encryptSecret(authorization.verifier),
    oauthStartedAt: new Date(),
    oauthStartedByUserId: user.id,
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

    const outcome = await withSideshiftLock(
      async () => {
        const row = await loadConnection()

        if (row?.refreshTokenEncrypted && row.clientId) {
          try {
            await revokeRefreshToken(
              clientCredentials(row),
              decryptSecret(row.refreshTokenEncrypted)
            )
          } catch (error) {
            // Still disconnect locally. The token is forgotten either way and
            // the founder can remove Yak from Sideshift's own settings.
            logger.warn({ err: error }, "Could not revoke the Sideshift token")
          }
        }

        await updateConnection(DISCONNECTED_VALUES)
        await clearSideshiftCache()
      },
      { waitMs: LOCK_WAIT_MS }
    )

    if (!outcome.acquired) {
      throw new ConflictError("A sync is running. Try again in a minute.")
    }

    await recordActivity({
      userId: user.id,
      action: "deleted",
      section: "integrations",
      summary: "Disconnected Sideshift",
      ipAddress: req.ip,
    })

    res.json({ data: await sideshiftStatus({ privileged: true }) })
  }
)

/* -------------------------------------------------------------------------- */
/* OAuth callback                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Where Sideshift sends the browser after consent. Mounted outside the session
 * guard because the panel and API live on different hosts: the request is
 * authenticated by the one-time `state` an owner or admin created by clicking
 * Connect, and it always ends by redirecting back to the Marketing tab.
 */
export const sideshiftCallbackRouter: Router = Router()

sideshiftCallbackRouter.get("/sideshift/callback", async (req, res) => {
  const back = (outcome: string) =>
    res.redirect(303, `${env.APP_URL}/marketing?sideshift=${outcome}`)
  const param = (name: string) => {
    const value = req.query[name]
    return typeof value === "string" ? value : null
  }

  const state = param("state")
  const row = await loadConnection()

  if (
    !state ||
    !row?.oauthStateHash ||
    !row.oauthVerifierEncrypted ||
    !safeEqual(sha256(state), row.oauthStateHash)
  ) {
    back("invalid_state")
    return
  }

  const startedBy = row.oauthStartedByUserId
  const verifier = decryptSecret(row.oauthVerifierEncrypted)
  const expired =
    !row.oauthStartedAt ||
    Date.now() - row.oauthStartedAt.getTime() > AUTHORIZATION_TTL_MS

  // Single use, whatever happens next.
  await updateConnection({
    oauthStateHash: null,
    oauthVerifierEncrypted: null,
    oauthStartedAt: null,
    oauthStartedByUserId: null,
  })

  if (expired) {
    back("expired")
    return
  }

  const error = param("error")

  if (error) {
    back(error === "access_denied" ? "denied" : "error")
    return
  }

  // RFC 9207: the issuer must be Sideshift's when it says who it is.
  const issuer = param("iss")
  const code = param("code")

  if ((issuer && issuer !== SIDESHIFT_ISSUER) || !code) {
    back("error")
    return
  }

  try {
    const outcome = await withSideshiftLock(
      async () => {
        const current = (await loadConnection())!
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
            decryptSecret(current.refreshTokenEncrypted)
          ).catch((revokeError: unknown) => {
            logger.warn({ err: revokeError }, "Could not revoke the old Sideshift token")
          })
        }

        const switchedCompany =
          Boolean(current.companyId && tokens.company.id) &&
          current.companyId !== tokens.company.id

        if (switchedCompany) {
          await clearSideshiftCache()
        }

        await saveTokens(tokens)
        await updateConnection({
          status: "connected",
          companyId: tokens.company.id,
          companyName: tokens.company.name,
          connectedAt: new Date(),
          connectedByUserId: startedBy,
          syncStartedAt: null,
          lastError: null,
          lastErrorAt: null,
          lastErrorRequestId: null,
        })
      },
      { waitMs: LOCK_WAIT_MS }
    )

    if (!outcome.acquired) {
      back("busy")
      return
    }
  } catch (exchangeError) {
    logger.error(
      {
        err: exchangeError instanceof SideshiftError ? undefined : exchangeError,
        code: exchangeError instanceof SideshiftError ? exchangeError.code : undefined,
        requestId:
          exchangeError instanceof SideshiftError ? exchangeError.requestId : undefined,
      },
      "Sideshift token exchange failed"
    )
    back("error")
    return
  }

  if (startedBy) {
    await recordActivity({
      userId: startedBy,
      action: "updated",
      section: "integrations",
      summary: "Connected Sideshift",
      ipAddress: req.ip,
    })
  }

  startSync("immediate")
  back("connected")
})

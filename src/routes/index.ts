import { type RequestHandler, Router } from "express"

import { env } from "../env.js"
import { serializeSettings } from "../lib/serializers.js"
import {
  getTenantId,
  requireActiveApp,
  requireApp,
  requireAuth,
  requirePasswordChanged,
  requireSuperAdmin,
  requireTenantUser,
  scopeSession,
} from "../middleware/auth.js"
import {
  requireApiKeyManagement,
  requirePermission,
} from "../middleware/permissions.js"
import {
  authLimiter,
  ingestAuthLimiter,
  panelAuthLimiter,
  panelLimiter,
  uploadLimiter,
} from "../middleware/rate-limit.js"
import { activityRouter } from "./activity.js"
import { adminRouter } from "./admin.js"
import { analyticsRouter } from "./analytics.js"
import { apiKeysRouter } from "./api-keys.js"
import { appUsersRouter } from "./app-users.js"
import { appsRouter } from "./apps.js"
import { billingRouter } from "./billing.js"
import { dashboardRouter } from "./dashboard.js"
import { discordRouter } from "./discord.js"
import { integrationsRouter } from "./integrations.js"
import { kpisRouter } from "./kpis.js"
import { meRouter } from "./me.js"
import { mediaRouter } from "./media.js"
import { publicEventsRouter } from "./public/events.js"
import { publicReportsRouter } from "./public/reports.js"
import { publicUsersRouter } from "./public/users.js"
import { reportsRouter } from "./reports.js"
import { loadSettings, settingsRouter } from "./settings.js"
import { sideshiftCallbackRouter, sideshiftRouter } from "./sideshift.js"
import { systemUsersRouter } from "./system-users.js"
import { tasksRouter } from "./tasks.js"
import { uploadsRouter } from "./uploads.js"
import { webhookEndpointsRouter } from "./webhook-endpoints.js"

export const apiRouter: Router = Router()

/* -------------------------------------------------------------------------- */
/* Public ingest API - authenticated with API keys, called by the integrating  */
/* application rather than the panel.                                          */
/* -------------------------------------------------------------------------- */

// Rejected keys are counted per IP before any of them costs a database
// lookup; the per-key limiters inside the routers handle accepted traffic.
apiRouter.use("/v1", ingestAuthLimiter)
apiRouter.use("/v1/reports", publicReportsRouter)
apiRouter.use("/v1/events", publicEventsRouter)
apiRouter.use("/v1/users", publicUsersRouter)

/** Applies `guard` to everything but reads. */
function forWrites(guard: RequestHandler): RequestHandler {
  return (req, res, next) => {
    if (req.method === "GET" || req.method === "HEAD") {
      next()
      return
    }

    guard(req, res, next)
  }
}

/* -------------------------------------------------------------------------- */
/* Panel API - authenticated with the session cookie.                          */
/* -------------------------------------------------------------------------- */

const panel: Router = Router()

// Every route below this line requires a live session, runs in that session's
// database scope (the user's tenant, or the staff scope for super admins), and
// an account with a pending forced password change can only reach its own
// profile.
panel.use(
  panelAuthLimiter,
  requireAuth,
  panelLimiter,
  scopeSession,
  requirePasswordChanged
)

// Everyone signed in, super admins included, can manage their own profile.
panel.use("/me", meRouter)

// Account management for Yak staff. Never touches a customer's panel data
// except to create, suspend, and staff the account itself. The staff database
// scope it runs in cannot read end user tables at all.
panel.use("/admin", requireSuperAdmin, adminRouter)

// The customer panel. Every route from here on acts on the signed-in user's
// own tenant, and is closed to super admins and suspended tenants.
panel.use(requireTenantUser)

// The tenant's brand, for every signed-in user. Editing it is the theme
// section; reading it is not gated, since it is painted on every page.
panel.get("/branding", async (req, res) => {
  res.json({ data: serializeSettings(await loadSettings(getTenantId(req))) })
})

/* Account level: the team and its tools. */

// Reading the roster is a section permission; changing it requires the
// owner or admin role, enforced inside the router.
panel.use(
  "/system-users",
  requirePermission("user-management"),
  systemUsersRouter
)
panel.use("/activity", requirePermission("user-management"), activityRouter)

panel.use("/apps", appsRouter)
panel.use("/billing", requireApiKeyManagement, billingRouter)
panel.use("/tasks", requirePermission("tasks"), tasksRouter)
panel.use("/settings", requirePermission("theme"), settingsRouter)
// Pointing a trigger at a Discord server decides where end user data goes,
// so like every other integration credential it is an owner/admin change.
panel.use(
  "/discord",
  requirePermission("discord"),
  forWrites(requireApiKeyManagement),
  discordRouter
)
panel.use("/sideshift", requirePermission("marketing"), sideshiftRouter)
panel.use("/webhook-endpoints", requireApiKeyManagement, webhookEndpointsRouter)

// A user only ever reads and writes their own layout, so no section gate: the
// widgets themselves read from endpoints that are already permission checked.
panel.use("/dashboard", dashboardRouter)

panel.use("/uploads", uploadLimiter, uploadsRouter)

/* App level: what one of the account's apps sent, and its credentials. */

// `:appId` is resolved against the signed-in tenant before any of these run,
// so a route cannot be reached for an app the tenant does not own.
const appScoped: Router = Router({ mergeParams: true })

appScoped.use(requireApp)
// An archived app is read only: its history stays visible, nothing changes.
appScoped.use(forWrites(requireActiveApp))
appScoped.use("/reports", requirePermission("reports"), reportsRouter)
appScoped.use("/analytics", requirePermission("analytics"), analyticsRouter)
appScoped.use("/kpis", requirePermission("kpis"), kpisRouter)
appScoped.use("/app-users", requirePermission("users"), appUsersRouter)

// Reading connection state is open to every signed-in user because the
// dashboard needs it to decide which widgets can be offered. Writing a
// credential is gated inside the router on the owner/admin role.
appScoped.use("/integrations", integrationsRouter)
appScoped.use("/api-keys", requireApiKeyManagement, apiKeysRouter)

panel.use("/apps/:appId", appScoped)

apiRouter.use(panel)

/* -------------------------------------------------------------------------- */
/* Unauthenticated metadata                                                    */
/* -------------------------------------------------------------------------- */

export const publicMetaRouter: Router = Router()

// Stable avatar/logo URLs redirect here to short-lived R2 signed GETs.
publicMetaRouter.use("/media", mediaRouter)

// Sideshift's OAuth redirect. Authenticated by its one-time `state`, not the
// session cookie, which lives on the panel's host rather than this one. The
// auth limiter fits: it is hit once per connect, like a sign-in.
//
// The limiter is mounted on the callback path only. A pathless `use` would run
// it for every request through this router, and since this router sits in
// front of the whole panel API, that throttled all of `/api` at 30 requests per
// five minutes per IP.
publicMetaRouter.use("/sideshift/callback", authLimiter)
publicMetaRouter.use(sideshiftCallbackRouter)

/**
 * What the login screen needs before anyone signs in.
 *
 * One deployment now serves every customer and the login screen cannot know
 * which one is signing in, so it shows the product's own branding. A tenant's
 * brand is applied after sign in, from /settings/theme.
 */
publicMetaRouter.get("/config", (_req, res) => {
  res.json({
    data: {
      tenantName: env.APP_NAME,
      tenantSlug: null,
      signUpEnabled: false,
      passwordMinLength: 12,
      branding: {
        brandName: env.APP_NAME,
        logoUrl: null,
        primaryColor: "#339af0",
        defaultTheme: "system",
      },
    },
  })
})

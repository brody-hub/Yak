import { Router } from "express"

import { env } from "../env.js"
import { requireAuth, requirePasswordChanged } from "../middleware/auth.js"
import {
  requireApiKeyManagement,
  requirePermission,
} from "../middleware/permissions.js"
import { panelLimiter, uploadLimiter } from "../middleware/rate-limit.js"
import { signedImageUrl } from "../services/r2.js"
import { activityRouter } from "./activity.js"
import { analyticsRouter } from "./analytics.js"
import { apiKeysRouter } from "./api-keys.js"
import { appUsersRouter } from "./app-users.js"
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
import { systemUsersRouter } from "./system-users.js"
import { tasksRouter } from "./tasks.js"
import { uploadsRouter } from "./uploads.js"
import { webhookEndpointsRouter } from "./webhook-endpoints.js"

export const apiRouter: Router = Router()

/* -------------------------------------------------------------------------- */
/* Public ingest API - authenticated with API keys, called by the integrating  */
/* application rather than the panel.                                          */
/* -------------------------------------------------------------------------- */

apiRouter.use("/v1/reports", publicReportsRouter)
apiRouter.use("/v1/events", publicEventsRouter)
apiRouter.use("/v1/users", publicUsersRouter)

/* -------------------------------------------------------------------------- */
/* Panel API - authenticated with the session cookie.                          */
/* -------------------------------------------------------------------------- */

const panel: Router = Router()

// Every route below this line requires a live session, and an account with a
// pending forced password change can only reach its own profile.
panel.use(requireAuth, panelLimiter, requirePasswordChanged)

panel.use("/me", meRouter)

// Reading the roster is a section permission; changing it requires the
// owner or admin role, enforced inside the router.
panel.use(
  "/system-users",
  requirePermission("user-management"),
  systemUsersRouter
)
panel.use("/activity", requirePermission("user-management"), activityRouter)

panel.use("/tasks", requirePermission("tasks"), tasksRouter)
panel.use("/reports", requirePermission("reports"), reportsRouter)
panel.use("/analytics", requirePermission("analytics"), analyticsRouter)
panel.use("/kpis", requirePermission("kpis"), kpisRouter)
panel.use("/app-users", requirePermission("users"), appUsersRouter)
panel.use("/settings", requirePermission("theme"), settingsRouter)
panel.use("/discord", requirePermission("discord"), discordRouter)

// A user only ever reads and writes their own layout, so no section gate: the
// widgets themselves read from endpoints that are already permission checked.
panel.use("/dashboard", dashboardRouter)

// Reading connection state is open to every signed-in user because the
// dashboard needs it to decide which widgets can be offered. Writing a
// credential is gated inside the router on the owner/admin role.
panel.use("/integrations", integrationsRouter)

panel.use("/api-keys", requireApiKeyManagement, apiKeysRouter)
panel.use("/webhook-endpoints", requireApiKeyManagement, webhookEndpointsRouter)

panel.use("/uploads", uploadLimiter, uploadsRouter)

apiRouter.use(panel)

/* -------------------------------------------------------------------------- */
/* Unauthenticated metadata                                                    */
/* -------------------------------------------------------------------------- */

export const publicMetaRouter: Router = Router()

// Stable avatar/logo URLs redirect here to short-lived R2 signed GETs.
publicMetaRouter.use("/media", mediaRouter)

/**
 * Lets the login screen render tenant branding before anyone signs in.
 *
 * Only the brand name, logo, and colour are exposed here. Those are visible on
 * every page of the panel anyway, so there is nothing to protect, and putting
 * them behind auth would mean an unbranded login screen.
 */
publicMetaRouter.get("/config", async (_req, res) => {
  const settings = await loadSettings()

  res.json({
    data: {
      tenantName: env.TENANT_NAME,
      tenantSlug: env.TENANT_SLUG,
      signUpEnabled: false,
      passwordMinLength: 12,
      branding: {
        brandName: settings.brandName,
        logoUrl: settings.logoImageId
          ? signedImageUrl(settings.logoImageId)
          : null,
        primaryColor: settings.primaryColor,
        defaultTheme: settings.defaultTheme,
      },
    },
  })
})

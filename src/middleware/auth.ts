import { fromNodeHeaders } from "better-auth/node"
import { and, eq } from "drizzle-orm"
import type { NextFunction, Request, RequestHandler, Response } from "express"

import { auth } from "../auth/auth.js"
import type { AppContext, AuthContext } from "../auth/context.js"
import {
  type AccountRole,
  effectivePermissions,
  isSuperAdminRole,
  isValidRole,
} from "../auth/permissions.js"
import { db } from "../db/index.js"
import { apps, tenants, user as userTable } from "../db/schema.js"
import { enterRequestScope } from "../db/scope.js"
import {
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from "../lib/errors.js"

/**
 * Resolves the session cookie into a full identity.
 *
 * The user row is re-read from the database on every request instead of
 * trusting the session payload, so revoking a permission, changing a role, or
 * banning an account takes effect on the very next request.
 */
async function resolveAuthContext(req: Request): Promise<AuthContext | null> {
  const result = await auth.api.getSession({
    headers: fromNodeHeaders(req.headers),
  })

  if (!result?.session?.userId) {
    return null
  }

  const [found] = await db
    .select({ user: userTable, tenant: tenants })
    .from(userTable)
    .leftJoin(tenants, eq(tenants.id, userTable.tenantId))
    .where(eq(userTable.id, result.session.userId))
    .limit(1)

  if (!found) {
    return null
  }

  const { user: row, tenant } = found

  // A tenant user whose tenant row is gone has nothing left to act on.
  if (!isSuperAdminRole(row.role) && !tenant) {
    return null
  }

  const role: AccountRole = isSuperAdminRole(row.role)
    ? row.role
    : isValidRole(row.role)
      ? row.role
      : "member"

  return {
    user: {
      id: row.id,
      tenantId: row.tenantId,
      name: row.name,
      email: row.email,
      role,
      permissions: row.permissions ?? [],
      mustChangePassword: row.mustChangePassword,
      avatarImageId: row.avatarImageId,
      banned: row.banned,
    },
    session: {
      id: result.session.id,
      expiresAt: new Date(result.session.expiresAt),
    },
    permissions: effectivePermissions({
      role,
      permissions: row.permissions ?? [],
    }),
    tenant: tenant
      ? {
          id: tenant.id,
          name: tenant.name,
          slug: tenant.slug,
          status: tenant.status,
        }
      : null,
  }
}

/** Attaches `req.auth` when a valid session exists, but never rejects. */
export const attachSession: RequestHandler = async (req, _res, next) => {
  try {
    const context = await resolveAuthContext(req)

    if (context) {
      req.auth = context
    }

    next()
  } catch (error) {
    next(error)
  }
}

/** Rejects the request unless a valid, active session is present. */
export const requireAuth: RequestHandler = async (
  req: Request,
  _res: Response,
  next: NextFunction
) => {
  try {
    const context = req.auth ?? (await resolveAuthContext(req))

    if (!context) {
      throw new UnauthorizedError()
    }

    if (context.user.banned) {
      throw new ForbiddenError("This account has been deactivated")
    }

    req.auth = context
    next()
  } catch (error) {
    next(error)
  }
}

/**
 * Binds the rest of the request to the signed-in user's database scope: their
 * tenant for customer users, the staff scope for super admins. Row level
 * security then confines every query the handlers run. Mount right after
 * requireAuth.
 */
export const scopeSession: RequestHandler = (req, res, next) => {
  const context = req.auth

  if (!context) {
    next(new UnauthorizedError())
    return
  }

  const scope = context.user.tenantId
    ? ({ kind: "tenant", tenantId: context.user.tenantId } as const)
    : isSuperAdminRole(context.user.role)
      ? ({ kind: "staff" } as const)
      : null

  if (!scope) {
    next(new ForbiddenError("This account is not attached to a workspace"))
    return
  }

  void enterRequestScope(req, res, scope, next)
}

/**
 * Paths an account with a pending forced password change may still reach.
 * Anything else is blocked until the temporary password is replaced.
 */
const PASSWORD_CHANGE_ALLOWLIST = new Set([
  "GET /me",
  "POST /me/password",
  "POST /me/logout",
])

/**
 * Invited users receive a temporary password by email. Until they replace it
 * their session can read their own profile and change the password, nothing
 * else.
 */
export const requirePasswordChanged: RequestHandler = (req, _res, next) => {
  if (!req.auth?.user.mustChangePassword) {
    next()
    return
  }

  // `req.path` here is relative to the router this middleware is mounted on.
  const key = `${req.method} ${req.path.replace(/\/+$/, "") || "/"}`

  if (PASSWORD_CHANGE_ALLOWLIST.has(key)) {
    next()
    return
  }

  next(
    new ForbiddenError("You must choose a new password before using the panel")
  )
}

/**
 * Gates the customer panel. Super admins are turned away (they manage accounts
 * from /api/admin and never act inside a customer's data), and so is everyone
 * in a suspended tenant.
 */
export const requireTenantUser: RequestHandler = (req, _res, next) => {
  const context = req.auth

  if (!context) {
    next(new UnauthorizedError())
    return
  }

  if (!context.tenant || !context.user.tenantId) {
    next(
      new ForbiddenError(
        "Super admins manage accounts from the admin console, not the panel"
      )
    )
    return
  }

  if (context.tenant.status !== "active") {
    next(new ForbiddenError("This account has been suspended"))
    return
  }

  next()
}

/** Gates the account management API behind the super admin role. */
export const requireSuperAdmin: RequestHandler = (req, _res, next) => {
  if (!req.auth) {
    next(new UnauthorizedError())
    return
  }

  if (!isSuperAdminRole(req.auth.user.role)) {
    next(new ForbiddenError("Only super admins can manage accounts"))
    return
  }

  next()
}

/**
 * Resolves the `:appId` path parameter to one of the tenant's own apps and
 * attaches it as `req.currentApp`. Another tenant's app id is a 404, exactly
 * like an id that does not exist, so ids cannot be probed. Row level security
 * would already hide the row; the explicit tenant check is belt and braces.
 *
 * Archived apps stay readable so their history is not lost, but refuse
 * writes; routers that mutate call requireActiveApp as well.
 */
export const requireApp: RequestHandler = async (req, _res, next) => {
  try {
    const tenantId = getTenantId(req)
    const appId = req.params.appId

    if (typeof appId !== "string" || appId.length === 0 || appId.length > 64) {
      throw new NotFoundError("App")
    }

    const [row] = await db
      .select()
      .from(apps)
      .where(and(eq(apps.id, appId), eq(apps.tenantId, tenantId)))
      .limit(1)

    if (!row || row.tenantId !== tenantId) {
      throw new NotFoundError("App")
    }

    const context: AppContext = {
      id: row.id,
      tenantId: row.tenantId,
      name: row.name,
      slug: row.slug,
      status: row.status,
    }

    req.currentApp = context
    next()
  } catch (error) {
    next(error)
  }
}

/** Refuses writes against an archived app. */
export const requireActiveApp: RequestHandler = (req, _res, next) => {
  if (!req.currentApp) {
    next(new NotFoundError("App"))
    return
  }

  if (req.currentApp.status !== "active") {
    next(new ForbiddenError("This app has been archived"))
    return
  }

  next()
}

export function getAuth(req: Request): AuthContext {
  if (!req.auth) {
    throw new UnauthorizedError()
  }

  return req.auth
}

/**
 * The app the request acts on, from the path (panel) or the API key (ingest).
 * Throws so a route that forgot its app guard fails closed.
 */
export function getAppId(req: Request): string {
  const appId = req.apiKey?.appId ?? req.currentApp?.id

  if (!appId) {
    throw new ForbiddenError("This request is not scoped to an app")
  }

  return appId
}

/** Both ids at once, for inserts into app-scoped tables. */
export function getScope(req: Request): { tenantId: string; appId: string } {
  return { tenantId: getTenantId(req), appId: getAppId(req) }
}

/**
 * The tenant the request acts on, from the session or the API key. Every query
 * against a customer-owned table filters on this.
 *
 * Throws rather than returning null so a route that forgot its tenant guard
 * fails closed instead of reading across tenants.
 */
export function getTenantId(req: Request): string {
  const tenantId = req.apiKey?.tenantId ?? req.auth?.user.tenantId

  if (!tenantId) {
    throw new ForbiddenError("This request is not scoped to an account")
  }

  return tenantId
}

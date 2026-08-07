import { fromNodeHeaders } from "better-auth/node"
import { eq } from "drizzle-orm"
import type { NextFunction, Request, RequestHandler, Response } from "express"

import { auth } from "../auth/auth.js"
import type { AuthContext } from "../auth/context.js"
import { effectivePermissions, isValidRole } from "../auth/permissions.js"
import { db } from "../db/index.js"
import { user as userTable } from "../db/schema.js"
import { ForbiddenError, UnauthorizedError } from "../lib/errors.js"

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

  const [row] = await db
    .select()
    .from(userTable)
    .where(eq(userTable.id, result.session.userId))
    .limit(1)

  if (!row) {
    return null
  }

  const role = isValidRole(row.role) ? row.role : "member"

  return {
    user: {
      id: row.id,
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
    new ForbiddenError(
      "You must choose a new password before using the panel"
    )
  )
}

export function getAuth(req: Request): AuthContext {
  if (!req.auth) {
    throw new UnauthorizedError()
  }

  return req.auth
}

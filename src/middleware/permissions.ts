import type { RequestHandler } from "express"

import type { PanelPermissionId } from "../auth/permissions.js"
import { canManageUsers, canMintApiKeys } from "../auth/permissions.js"
import { ForbiddenError, UnauthorizedError } from "../lib/errors.js"

/** Gates a route behind a panel section permission. */
export function requirePermission(
  permission: PanelPermissionId
): RequestHandler {
  return (req, _res, next) => {
    if (!req.auth) {
      next(new UnauthorizedError())
      return
    }

    if (!req.auth.permissions.includes(permission)) {
      next(
        new ForbiddenError(
          `You do not have access to the ${permission} section`
        )
      )
      return
    }

    next()
  }
}

/** Gates a route behind the ability to administer other panel users. */
export const requireUserManagement: RequestHandler = (req, _res, next) => {
  if (!req.auth) {
    next(new UnauthorizedError())
    return
  }

  if (!canManageUsers(req.auth.user)) {
    next(new ForbiddenError("Only owners and admins can manage panel users"))
    return
  }

  next()
}

/** Gates a route behind the ability to mint and revoke API keys. */
export const requireApiKeyManagement: RequestHandler = (req, _res, next) => {
  if (!req.auth) {
    next(new UnauthorizedError())
    return
  }

  if (!canMintApiKeys(req.auth.user)) {
    next(new ForbiddenError("Only owners and admins can manage API keys"))
    return
  }

  next()
}

/** Gates a route behind the owner role. */
export const requireOwner: RequestHandler = (req, _res, next) => {
  if (!req.auth) {
    next(new UnauthorizedError())
    return
  }

  if (req.auth.user.role !== "owner") {
    next(new ForbiddenError("Only an owner can perform this action"))
    return
  }

  next()
}

/**
 * Better Auth admin-plugin access control.
 *
 * Our panel's own section permissions live in permissions.ts and are enforced
 * by our middleware. This file only satisfies Better Auth's requirement that
 * every value used in `adminRoles` also appears in `roles`.
 */
import { createAccessControl } from "better-auth/plugins/access"
import {
  adminAc,
  defaultStatements,
  userAc,
} from "better-auth/plugins/admin/access"

const statement = {
  ...defaultStatements,
} as const

export const ac = createAccessControl(statement)

/** Full admin surface, including acting on other admins. */
export const ownerRole = ac.newRole({
  ...adminAc.statements,
  user: [
    "create",
    "list",
    "set-role",
    "ban",
    "impersonate",
    "impersonate-admins",
    "delete",
    "set-password",
    "set-email",
    "get",
    "update",
  ],
})

export const adminRole = ac.newRole({
  ...adminAc.statements,
})

/** No Better Auth admin endpoints — panel section access is separate. */
export const memberRole = ac.newRole({
  ...userAc.statements,
})

export const authRoles = {
  owner: ownerRole,
  admin: adminRole,
  member: memberRole,
} as const

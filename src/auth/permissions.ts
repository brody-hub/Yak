/**
 * Authorization model.
 *
 * Two independent axes:
 *
 *  - `role` decides who may administer the panel itself (invite users, change
 *    another user's access, mint API keys).
 *  - `permissions` decides which sections of the panel a user can read and
 *    write. Owners and admins implicitly hold every permission.
 */

export const PANEL_PERMISSIONS = [
  "dashboard",
  "kpis",
  "tasks",
  "users",
  "reports",
  "analytics",
  "user-management",
  "theme",
  "discord",
] as const

export type PanelPermissionId = (typeof PANEL_PERMISSIONS)[number]

export const PANEL_PERMISSION_GROUPS: Record<
  PanelPermissionId,
  { label: string; group: "Main" | "Support" | "Settings" }
> = {
  dashboard: { label: "Dashboard", group: "Main" },
  kpis: { label: "KPIs", group: "Main" },
  tasks: { label: "Tasks", group: "Main" },
  users: { label: "Users", group: "Support" },
  reports: { label: "Reports", group: "Support" },
  analytics: { label: "Analytics", group: "Support" },
  "user-management": { label: "User management", group: "Settings" },
  theme: { label: "Theme", group: "Settings" },
  discord: { label: "Discord", group: "Settings" },
}

export const USER_ROLES = ["owner", "admin", "member"] as const
export type UserRole = (typeof USER_ROLES)[number]

export const ROLE_LABELS: Record<UserRole, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
}

export const ROLE_DESCRIPTIONS: Record<UserRole, string> = {
  owner:
    "Full access. Can manage every user including admins, and cannot be removed.",
  admin:
    "Full section access and can invite, edit, and deactivate members. Cannot change owners.",
  member: "Access is limited to the sections explicitly granted below.",
}

/** Roles that may administer other panel users and mint API keys. */
const USER_MANAGING_ROLES: readonly UserRole[] = ["owner", "admin"]

export function isValidPermission(value: string): value is PanelPermissionId {
  return (PANEL_PERMISSIONS as readonly string[]).includes(value)
}

export function isValidRole(value: string): value is UserRole {
  return (USER_ROLES as readonly string[]).includes(value)
}

export type Principal = {
  id: string
  role: UserRole
  permissions: string[]
}

/** Owners and admins hold every section permission implicitly. */
export function effectivePermissions(
  principal: Pick<Principal, "role" | "permissions">
): PanelPermissionId[] {
  if (USER_MANAGING_ROLES.includes(principal.role)) {
    return [...PANEL_PERMISSIONS]
  }

  return principal.permissions.filter(isValidPermission)
}

export function hasPermission(
  principal: Pick<Principal, "role" | "permissions">,
  permission: PanelPermissionId
): boolean {
  return effectivePermissions(principal).includes(permission)
}

export function canManageUsers(
  principal: Pick<Principal, "role">
): boolean {
  return USER_MANAGING_ROLES.includes(principal.role)
}

export function canMintApiKeys(principal: Pick<Principal, "role">): boolean {
  return USER_MANAGING_ROLES.includes(principal.role)
}

/**
 * Whether `actor` is allowed to modify `target`.
 *
 * Rules that keep an instance from being taken over:
 *  - only owners may modify another owner
 *  - only owners may grant or revoke the owner role
 *  - nobody may change their own role or deactivate themselves
 */
export function canManageTargetUser(
  actor: Pick<Principal, "id" | "role">,
  target: { id: string; role: UserRole }
): { allowed: true } | { allowed: false; reason: string } {
  if (!canManageUsers(actor)) {
    return { allowed: false, reason: "Your role cannot manage panel users" }
  }

  if (target.role === "owner" && actor.role !== "owner") {
    return { allowed: false, reason: "Only an owner can modify another owner" }
  }

  return { allowed: true }
}

export function canAssignRole(
  actor: Pick<Principal, "id" | "role">,
  nextRole: UserRole,
  target: { id: string; role: UserRole }
): { allowed: true } | { allowed: false; reason: string } {
  const manage = canManageTargetUser(actor, target)

  if (!manage.allowed) {
    return manage
  }

  if (actor.id === target.id) {
    return { allowed: false, reason: "You cannot change your own role" }
  }

  if (nextRole === "owner" && actor.role !== "owner") {
    return { allowed: false, reason: "Only an owner can grant the owner role" }
  }

  return { allowed: true }
}

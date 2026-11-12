import type { AccountRole, PanelPermissionId } from "./permissions.js"

/** The customer account a request acts on. */
export type TenantContext = {
  id: string
  name: string
  slug: string
  status: "active" | "suspended"
}

/** One of the account's apps, once a request has been bound to it. */
export type AppContext = {
  id: string
  tenantId: string
  name: string
  slug: string
  status: "active" | "archived"
}

/** Resolved identity for a request authenticated with a session cookie. */
export type AuthContext = {
  user: {
    id: string
    /** Null only for super admins. */
    tenantId: string | null
    name: string
    email: string
    role: AccountRole
    permissions: string[]
    mustChangePassword: boolean
    avatarImageId: string | null
    banned: boolean
  }
  session: {
    id: string
    expiresAt: Date
  }
  /** Expanded permissions, with the owner/admin implicit grant applied. */
  permissions: PanelPermissionId[]
  /** The user's tenant. Null for super admins. */
  tenant: TenantContext | null
}

/** Resolved identity for a request authenticated with an API key. */
export type ApiKeyContext = {
  id: string
  tenantId: string
  /** The app the key was minted for. Everything it sends lands there. */
  appId: string
  name: string
  scopes: string[]
}

export const API_KEY_SCOPES = [
  "reports:write",
  "reports:read",
  "events:write",
  "users:write",
] as const

export type ApiKeyScope = (typeof API_KEY_SCOPES)[number]

export const API_KEY_SCOPE_LABELS: Record<ApiKeyScope, string> = {
  "reports:write": "Create reports and post reporter messages",
  "reports:read": "Read report status and conversation",
  "events:write": "Send analytics events",
  "users:write": "Create, update, and delete app users",
}

export function isValidScope(value: string): value is ApiKeyScope {
  return (API_KEY_SCOPES as readonly string[]).includes(value)
}

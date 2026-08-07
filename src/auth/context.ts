import type { PanelPermissionId, UserRole } from "./permissions.js"

/** Resolved identity for a request authenticated with a session cookie. */
export type AuthContext = {
  user: {
    id: string
    name: string
    email: string
    role: UserRole
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
}

/** Resolved identity for a request authenticated with an API key. */
export type ApiKeyContext = {
  id: string
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
  "users:write": "Create and update app users",
}

export function isValidScope(value: string): value is ApiKeyScope {
  return (API_KEY_SCOPES as readonly string[]).includes(value)
}

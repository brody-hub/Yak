import { effectivePermissions, isValidRole } from "../auth/permissions.js"
import type {
  ActivityLogEntry,
  AnalyticsEvent,
  ApiKey,
  AppSettings,
  AppUser,
  Report,
  ReportMessage,
  Sprint,
  Ticket,
  TicketHistoryEntry,
  User,
} from "../db/schema.js"
import { signedImageUrl } from "../services/r2.js"

/**
 * Deterministic fallback avatar. Matches the helper the panel uses so an
 * account without an uploaded image still renders the same illustration it did
 * before the backend existed.
 */
export function fallbackAvatarUrl(seed: string): string {
  const params = new URLSearchParams({
    seed,
    backgroundColor: "b6e3f4,c0aede,d1d4f9,ffd5dc,ffdfbf",
  })

  return `https://api.dicebear.com/9.x/avataaars/svg?${params.toString()}`
}

function avatarFor(
  row: Pick<User, "name" | "image" | "avatarImageId">
): string {
  if (row.avatarImageId) {
    const signed = signedImageUrl(row.avatarImageId)

    if (signed) {
      return signed
    }
  }

  // Inline data URLs (or absolute URLs) stored when Cloudflare Images is not
  // configured. Kept on the Better Auth `image` column.
  if (
    row.image &&
    (row.image.startsWith("data:image/") || /^https?:\/\//.test(row.image))
  ) {
    return row.image
  }

  return fallbackAvatarUrl(row.name)
}

/* -------------------------------------------------------------------------- */
/* Panel users                                                                 */
/* -------------------------------------------------------------------------- */

export function serializeSystemUser(row: User) {
  const role = isValidRole(row.role) ? row.role : "member"

  return {
    id: row.id,
    name: row.name,
    email: row.email,
    avatar: avatarFor(row),
    role,
    // Raw grants, so the edit form shows exactly what is stored.
    permissions: row.permissions ?? [],
    // What the grants actually resolve to once the role is applied.
    effectivePermissions: effectivePermissions({
      role,
      permissions: row.permissions ?? [],
    }),
    status: row.banned ? ("deactivated" as const) : ("active" as const),
    pendingInvite: row.mustChangePassword,
    lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  }
}

export type SerializedSystemUser = ReturnType<typeof serializeSystemUser>

/** The subset of the profile the signed-in user gets about themselves. */
export function serializeCurrentUser(row: User) {
  return {
    ...serializeSystemUser(row),
    mustChangePassword: row.mustChangePassword,
  }
}

/* -------------------------------------------------------------------------- */
/* Activity                                                                    */
/* -------------------------------------------------------------------------- */

export function serializeActivity(
  row: Pick<
    ActivityLogEntry,
    "id" | "userId" | "action" | "section" | "summary" | "createdAt"
  > & { userName?: string; userEmail?: string }
) {
  return {
    id: row.id,
    userId: row.userId,
    userName: row.userName ?? null,
    userEmail: row.userEmail ?? null,
    action: row.action,
    section: row.section,
    summary: row.summary,
    createdAt: row.createdAt.toISOString(),
  }
}

/* -------------------------------------------------------------------------- */
/* Tasks                                                                       */
/* -------------------------------------------------------------------------- */

export function serializeSprint(row: Sprint) {
  return {
    id: row.id,
    name: row.name,
    durationWeeks: row.durationWeeks,
    startDate: row.startDate.toISOString(),
    endDate: row.endDate.toISOString(),
  }
}

export function serializeTicket(row: Ticket) {
  return {
    id: row.id,
    number: row.number,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    sprintId: row.sprintId,
    assigneeId: row.assigneeId,
    sourceReportId: row.sourceReportId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

export function serializeTicketHistory(row: TicketHistoryEntry) {
  return {
    id: row.id,
    ticketId: row.ticketId,
    type: row.type,
    ...(row.field ? { field: row.field } : {}),
    from: row.fromValue,
    to: row.toValue,
    actorId: row.actorId,
    createdAt: row.createdAt.toISOString(),
  }
}

/* -------------------------------------------------------------------------- */
/* Reports                                                                     */
/* -------------------------------------------------------------------------- */

export function serializeReportMessage(row: ReportMessage) {
  return {
    id: row.id,
    authorType: row.authorType,
    authorName: row.authorName,
    body: row.body,
    isInternal: row.isInternal,
    createdAt: row.createdAt.toISOString(),
  }
}

export function serializeReport(row: Report, messages: ReportMessage[] = []) {
  return {
    id: row.id,
    number: row.number,
    type: row.type,
    status: row.status,
    priority: row.priority,
    subject: row.subject,
    body: row.body,
    userName: row.reporterName,
    userEmail: row.reporterEmail,
    externalUserId: row.externalUserId,
    platform: row.platform,
    appVersion: row.appVersion,
    assigneeId: row.assigneeId,
    source: row.source,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    messages: messages.map(serializeReportMessage),
  }
}

/** Trimmed shape returned to an integrating application over the public API. */
export function serializeReportForApi(
  row: Report,
  messages: ReportMessage[] = []
) {
  return {
    id: row.id,
    number: row.number,
    token: row.publicToken,
    type: row.type,
    status: row.status,
    priority: row.priority,
    subject: row.subject,
    body: row.body,
    reporter: {
      name: row.reporterName,
      email: row.reporterEmail,
      externalUserId: row.externalUserId,
    },
    platform: row.platform,
    appVersion: row.appVersion,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    messages: messages
      // Internal notes stay inside the panel.
      .filter((message) => !message.isInternal)
      .map((message) => ({
        id: message.id,
        author: message.authorType,
        authorName: message.authorName,
        body: message.body,
        createdAt: message.createdAt.toISOString(),
      })),
  }
}

/* -------------------------------------------------------------------------- */
/* Analytics                                                                   */
/* -------------------------------------------------------------------------- */

export function serializeAnalyticsEvent(row: AnalyticsEvent) {
  return {
    id: row.id,
    name: row.name,
    userId: row.externalUserId ?? row.anonymousId ?? "anonymous",
    userName: row.userName ?? "Unknown user",
    platform: row.platform ?? "web",
    properties: row.properties ?? {},
    createdAt: row.occurredAt.toISOString(),
  }
}

/* -------------------------------------------------------------------------- */
/* App users                                                                   */
/* -------------------------------------------------------------------------- */

export function serializeAppUser(row: AppUser) {
  return {
    id: row.externalId,
    name: row.name,
    email: row.email,
    avatar: row.avatarUrl ?? fallbackAvatarUrl(row.name),
    plan: row.plan,
    billingPeriod: row.billingPeriod,
    platform: row.platform,
    status: row.status,
    renewsAt: row.renewsAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  }
}

/* -------------------------------------------------------------------------- */
/* Settings                                                                    */
/* -------------------------------------------------------------------------- */

export function serializeSettings(row: AppSettings) {
  return {
    brandName: row.brandName,
    logoImageId: row.logoImageId,
    logoUrl: row.logoImageId ? signedImageUrl(row.logoImageId) : null,
    primaryColor: row.primaryColor,
    defaultTheme: row.defaultTheme,
    updatedAt: row.updatedAt.toISOString(),
  }
}

/* -------------------------------------------------------------------------- */
/* API keys                                                                    */
/* -------------------------------------------------------------------------- */

export function serializeApiKey(row: ApiKey) {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    scopes: row.scopes,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  }
}

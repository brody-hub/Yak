import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core"

/* -------------------------------------------------------------------------- */
/* Enums                                                                       */
/* -------------------------------------------------------------------------- */

export const userRoleEnum = pgEnum("user_role", ["owner", "admin", "member"])

export const activityActionEnum = pgEnum("activity_action", [
  "signed_in",
  "viewed",
  "created",
  "updated",
  "deleted",
  "invited",
  "exported",
])

export const ticketStatusEnum = pgEnum("ticket_status", [
  "backlog",
  "todo",
  "in_progress",
  "done",
])

export const ticketPriorityEnum = pgEnum("ticket_priority", [
  "urgent",
  "high",
  "medium",
  "low",
])

export const ticketHistoryTypeEnum = pgEnum("ticket_history_type", [
  "created",
  "updated",
])

export const ticketHistoryFieldEnum = pgEnum("ticket_history_field", [
  "title",
  "description",
  "status",
  "priority",
  "sprintId",
  "assigneeId",
])

export const reportTypeEnum = pgEnum("report_type", [
  "bug",
  "suggestion",
  "support",
  "report",
])

export const reportStatusEnum = pgEnum("report_status", [
  "open",
  "in_progress",
  "waiting",
  "resolved",
  "closed",
])

export const reportPriorityEnum = pgEnum("report_priority", [
  "urgent",
  "high",
  "medium",
  "low",
])

export const reportSourceEnum = pgEnum("report_source", ["api", "panel"])

export const messageAuthorTypeEnum = pgEnum("message_author_type", [
  "user",
  "agent",
])

export const platformEnum = pgEnum("platform", ["ios", "android", "web"])

export const appUserPlanEnum = pgEnum("app_user_plan", ["free", "plus", "pro"])

export const appUserBillingPeriodEnum = pgEnum("app_user_billing_period", [
  "none",
  "monthly",
  "annual",
])

export const appUserStatusEnum = pgEnum("app_user_status", [
  "active",
  "trialing",
  "churned",
])

export const discordTriggerEnum = pgEnum("discord_trigger", [
  "new_user",
  "new_support",
  "new_subscription",
  "ticket_status_change",
])

export const webhookDeliveryStatusEnum = pgEnum("webhook_delivery_status", [
  "pending",
  "succeeded",
  "failed",
])

/* -------------------------------------------------------------------------- */
/* Better Auth core tables                                                     */
/*                                                                             */
/* Column names follow the Better Auth drizzle adapter contract. Extra columns */
/* (role, permissions, mustChangePassword, ...) are declared to Better Auth as */
/* `user.additionalFields` in src/auth/auth.ts so they stay in sync.           */
/* -------------------------------------------------------------------------- */

export const user = pgTable(
  "user",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull().unique(),
    emailVerified: boolean("email_verified").notNull().default(false),
    image: text("image"),

    // Authorization
    role: userRoleEnum("role").notNull().default("member"),
    permissions: jsonb("permissions").$type<string[]>().notNull().default([]),

    // Invite / credential lifecycle
    mustChangePassword: boolean("must_change_password").notNull().default(false),
    invitedByUserId: text("invited_by_user_id"),
    invitedAt: timestamp("invited_at", { withTimezone: true }),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),

    // Avatar stored in Cloudflare Images (private, served via signed URL)
    avatarImageId: text("avatar_image_id"),

    // Better Auth admin plugin
    banned: boolean("banned").notNull().default(false),
    banReason: text("ban_reason"),
    banExpires: timestamp("ban_expires", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("user_role_idx").on(table.role)]
)

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    token: text("token").notNull().unique(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    impersonatedBy: text("impersonated_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("session_user_id_idx").on(table.userId)]
)

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", {
      withTimezone: true,
    }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", {
      withTimezone: true,
    }),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("account_user_id_idx").on(table.userId)]
)

export const verification = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)]
)

/* -------------------------------------------------------------------------- */
/* Panel activity log                                                          */
/* -------------------------------------------------------------------------- */

export const activityLog = pgTable(
  "activity_log",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    action: activityActionEnum("action").notNull(),
    section: text("section").notNull(),
    summary: text("summary").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    ipAddress: text("ip_address"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("activity_log_user_id_created_at_idx").on(
      table.userId,
      table.createdAt
    ),
    index("activity_log_created_at_idx").on(table.createdAt),
  ]
)

/* -------------------------------------------------------------------------- */
/* Tasks: sprints, tickets, ticket history                                     */
/* -------------------------------------------------------------------------- */

export const sprints = pgTable("sprints", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  durationWeeks: integer("duration_weeks").notNull(),
  startDate: timestamp("start_date", { withTimezone: true }).notNull(),
  endDate: timestamp("end_date", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
})

export const tickets = pgTable(
  "tickets",
  {
    id: text("id").primaryKey(),
    // Human facing identifier rendered as STAND-101 in the panel.
    number: integer("number")
      .notNull()
      .generatedAlwaysAsIdentity({ startWith: 101 }),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    status: ticketStatusEnum("status").notNull().default("backlog"),
    priority: ticketPriorityEnum("priority").notNull().default("medium"),
    sprintId: text("sprint_id").references(() => sprints.id, {
      onDelete: "set null",
    }),
    assigneeId: text("assignee_id").references(() => user.id, {
      onDelete: "set null",
    }),
    // Set when a ticket is escalated from a support report.
    sourceReportId: text("source_report_id"),
    createdByUserId: text("created_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("tickets_number_idx").on(table.number),
    index("tickets_sprint_id_idx").on(table.sprintId),
    index("tickets_assignee_id_idx").on(table.assigneeId),
    index("tickets_status_idx").on(table.status),
  ]
)

export const ticketHistory = pgTable(
  "ticket_history",
  {
    id: text("id").primaryKey(),
    ticketId: text("ticket_id")
      .notNull()
      .references(() => tickets.id, { onDelete: "cascade" }),
    type: ticketHistoryTypeEnum("type").notNull(),
    field: ticketHistoryFieldEnum("field"),
    fromValue: text("from_value"),
    toValue: text("to_value"),
    actorId: text("actor_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("ticket_history_ticket_id_created_at_idx").on(
      table.ticketId,
      table.createdAt
    ),
  ]
)

/* -------------------------------------------------------------------------- */
/* Reports: customer service inbox fed by the public ingest API                */
/* -------------------------------------------------------------------------- */

export const reports = pgTable(
  "reports",
  {
    id: text("id").primaryKey(),
    number: integer("number")
      .notNull()
      .generatedAlwaysAsIdentity({ startWith: 1001 }),
    type: reportTypeEnum("type").notNull(),
    status: reportStatusEnum("status").notNull().default("open"),
    priority: reportPriorityEnum("priority").notNull().default("medium"),
    subject: text("subject").notNull(),
    body: text("body").notNull(),

    // Reporter identity as supplied by the integrating application.
    reporterName: text("reporter_name").notNull(),
    reporterEmail: text("reporter_email").notNull(),
    externalUserId: text("external_user_id"),

    platform: platformEnum("platform").notNull().default("web"),
    appVersion: text("app_version"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),

    source: reportSourceEnum("source").notNull().default("api"),
    apiKeyId: text("api_key_id"),
    assigneeId: text("assignee_id").references(() => user.id, {
      onDelete: "set null",
    }),

    // Opaque token the integrator can use to poll status without an API key.
    publicToken: text("public_token").notNull(),

    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("reports_number_idx").on(table.number),
    uniqueIndex("reports_public_token_idx").on(table.publicToken),
    index("reports_type_status_idx").on(table.type, table.status),
    index("reports_assignee_id_idx").on(table.assigneeId),
    index("reports_reporter_email_idx").on(table.reporterEmail),
    index("reports_updated_at_idx").on(table.updatedAt),
  ]
)

export const reportMessages = pgTable(
  "report_messages",
  {
    id: text("id").primaryKey(),
    reportId: text("report_id")
      .notNull()
      .references(() => reports.id, { onDelete: "cascade" }),
    authorType: messageAuthorTypeEnum("author_type").notNull(),
    authorName: text("author_name").notNull(),
    // Set when an authenticated panel user wrote the message.
    authorUserId: text("author_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    body: text("body").notNull(),
    // Agent replies can be internal notes that are never exposed publicly.
    isInternal: boolean("is_internal").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("report_messages_report_id_created_at_idx").on(
      table.reportId,
      table.createdAt
    ),
  ]
)

/* -------------------------------------------------------------------------- */
/* Analytics events ingested from the integrating application                  */
/* -------------------------------------------------------------------------- */

export const analyticsEvents = pgTable(
  "analytics_events",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    externalUserId: text("external_user_id"),
    userName: text("user_name"),
    anonymousId: text("anonymous_id"),
    sessionId: text("session_id"),
    platform: platformEnum("platform"),
    appVersion: text("app_version"),
    properties: jsonb("properties")
      .$type<Record<string, string | number | boolean>>()
      .notNull()
      .default({}),
    apiKeyId: text("api_key_id"),
    // When the event happened on the client.
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    // When our API accepted it.
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("analytics_events_occurred_at_idx").on(table.occurredAt),
    index("analytics_events_name_occurred_at_idx").on(
      table.name,
      table.occurredAt
    ),
    index("analytics_events_external_user_id_idx").on(table.externalUserId),
  ]
)

/* -------------------------------------------------------------------------- */
/* App users: end users of the integrating application                         */
/* -------------------------------------------------------------------------- */

export const appUsers = pgTable(
  "app_users",
  {
    id: text("id").primaryKey(),
    externalId: text("external_id").notNull(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    avatarUrl: text("avatar_url"),
    plan: appUserPlanEnum("plan").notNull().default("free"),
    billingPeriod: appUserBillingPeriodEnum("billing_period")
      .notNull()
      .default("none"),
    platform: platformEnum("platform").notNull().default("web"),
    status: appUserStatusEnum("status").notNull().default("active"),
    renewsAt: timestamp("renews_at", { withTimezone: true }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("app_users_external_id_idx").on(table.externalId),
    index("app_users_email_idx").on(table.email),
    index("app_users_name_idx").on(table.name),
  ]
)

/* -------------------------------------------------------------------------- */
/* API keys for the public ingest API                                          */
/* -------------------------------------------------------------------------- */

export const apiKeys = pgTable(
  "api_keys",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    /** Non secret display prefix, e.g. `yak_live_9f3a2c`. */
    prefix: text("prefix").notNull(),
    /** SHA-256 of the full key. The plaintext key is never stored. */
    keyHash: text("key_hash").notNull(),
    scopes: jsonb("scopes").$type<string[]>().notNull().default([]),
    createdByUserId: text("created_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    lastUsedIp: text("last_used_ip"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("api_keys_key_hash_idx").on(table.keyHash),
    index("api_keys_prefix_idx").on(table.prefix),
  ]
)

/* -------------------------------------------------------------------------- */
/* Settings: branding/theme, Discord, outbound webhooks                        */
/* -------------------------------------------------------------------------- */

/** Single row keyed by `default`. One deployed instance serves one app. */
export const appSettings = pgTable("app_settings", {
  id: text("id").primaryKey().default("default"),
  brandName: text("brand_name").notNull().default("Stand"),
  logoImageId: text("logo_image_id"),
  primaryColor: text("primary_color").notNull().default("#339af0"),
  defaultTheme: text("default_theme").notNull().default("system"),
  updatedByUserId: text("updated_by_user_id").references(() => user.id, {
    onDelete: "set null",
  }),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
})

export const discordTriggers = pgTable("discord_triggers", {
  trigger: discordTriggerEnum("trigger").primaryKey(),
  enabled: boolean("enabled").notNull().default(false),
  /** AES-256-GCM ciphertext. Never returned to the client in plaintext. */
  webhookUrlEncrypted: text("webhook_url_encrypted"),
  /** Non secret hint shown in the UI, e.g. `discord.com/api/webhooks/…4821`. */
  webhookUrlHint: text("webhook_url_hint"),
  lastFiredAt: timestamp("last_fired_at", { withTimezone: true }),
  lastError: text("last_error"),
  updatedByUserId: text("updated_by_user_id").references(() => user.id, {
    onDelete: "set null",
  }),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
})

export const webhookEndpoints = pgTable(
  "webhook_endpoints",
  {
    id: text("id").primaryKey(),
    url: text("url").notNull(),
    /** AES-256-GCM ciphertext of the HMAC signing secret. */
    secretEncrypted: text("secret_encrypted").notNull(),
    secretHint: text("secret_hint").notNull(),
    events: jsonb("events").$type<string[]>().notNull().default([]),
    enabled: boolean("enabled").notNull().default(true),
    createdByUserId: text("created_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("webhook_endpoints_enabled_idx").on(table.enabled)]
)

export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: text("id").primaryKey(),
    endpointId: text("endpoint_id")
      .notNull()
      .references(() => webhookEndpoints.id, { onDelete: "cascade" }),
    event: text("event").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: webhookDeliveryStatusEnum("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    responseStatus: integer("response_status"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  },
  (table) => [
    index("webhook_deliveries_endpoint_id_created_at_idx").on(
      table.endpointId,
      table.createdAt
    ),
  ]
)

/* -------------------------------------------------------------------------- */
/* Inferred types                                                              */
/* -------------------------------------------------------------------------- */

export type User = typeof user.$inferSelect
export type Session = typeof session.$inferSelect
export type ActivityLogEntry = typeof activityLog.$inferSelect
export type Sprint = typeof sprints.$inferSelect
export type Ticket = typeof tickets.$inferSelect
export type TicketHistoryEntry = typeof ticketHistory.$inferSelect
export type Report = typeof reports.$inferSelect
export type ReportMessage = typeof reportMessages.$inferSelect
export type AnalyticsEvent = typeof analyticsEvents.$inferSelect
export type AppUser = typeof appUsers.$inferSelect
export type ApiKey = typeof apiKeys.$inferSelect
export type AppSettings = typeof appSettings.$inferSelect
export type DiscordTrigger = typeof discordTriggers.$inferSelect
export type WebhookEndpoint = typeof webhookEndpoints.$inferSelect

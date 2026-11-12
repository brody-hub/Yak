import { type SQL, sql } from "drizzle-orm"
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgPolicy,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core"

/* -------------------------------------------------------------------------- */
/* Enums                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * `super_admin` belongs to Yak staff, not to a customer. A super admin has no
 * tenant and can only reach the account management API under /api/admin.
 */
export const userRoleEnum = pgEnum("user_role", [
  "owner",
  "admin",
  "member",
  "super_admin",
])

export const tenantStatusEnum = pgEnum("tenant_status", ["active", "suspended"])

/** Pricing tiers, placed by monthly active users. See src/billing/plans.ts. */
export const planTierEnum = pgEnum("plan_tier", [
  "free",
  "starter",
  "growth",
  "pro",
  "studio",
  "scale",
])

export const appStatusEnum = pgEnum("app_status", ["active", "archived"])

/** How often a paid tier is billed. */
export const billingIntervalEnum = pgEnum("billing_interval", [
  "monthly",
  "annual",
])

/** Who created the account: Yak staff, or its owner through /signup. */
export const signupSourceEnum = pgEnum("signup_source", ["admin", "self_serve"])

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

/** Third party analytics/billing providers Stand can read metrics from. */
export const integrationProviderEnum = pgEnum("integration_provider", [
  "revenuecat",
])

export const sideshiftConnectionStatusEnum = pgEnum(
  "sideshift_connection_status",
  ["disconnected", "connected", "needs_reconnect", "subscription_inactive"]
)

/* -------------------------------------------------------------------------- */
/* Tenants: one row per customer account                                       */
/* -------------------------------------------------------------------------- */

/**
 * A customer account. Every customer-owned row carries `tenant_id`, every
 * query against those tables filters on it, and row level security (below)
 * makes Postgres enforce the same thing.
 *
 * `slug` is fixed once created: it prefixes the customer's R2 object keys.
 */
const CURRENT_TENANT = sql`nullif(current_setting('app.tenant_id', true), '')`
const STAFF_SCOPE = sql`nullif(current_setting('app.staff', true), '') = 'true'`
const LOOKUP_SCOPE = sql`nullif(current_setting('app.lookup', true), '') = 'true'`

export const tenants = pgTable(
  "tenants",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    status: tenantStatusEnum("status").notNull().default("active"),
    /**
     * The account's tier. Driven by the Stripe subscription once there is
     * one; otherwise set by hand from the admin console (Scale contracts).
     */
    plan: planTierEnum("plan").notNull().default("free"),
    stripeCustomerId: text("stripe_customer_id").unique(),
    stripeSubscriptionId: text("stripe_subscription_id").unique(),
    /** Stripe's subscription status (active, past_due, canceled, ...). */
    subscriptionStatus: text("subscription_status"),
    /**
     * A paid tier picked at sign up and not yet paid for. The account runs on
     * `plan` (Free) until checkout completes and the webhook clears this.
     */
    pendingPlan: planTierEnum("pending_plan"),
    pendingInterval: billingIntervalEnum("pending_interval"),
    signupSource: signupSourceEnum("signup_source").notNull().default("admin"),
    /** Last ticket number handed out; the next ticket gets this plus one. */
    ticketSeq: integer("ticket_seq").notNull().default(100),
    /** Last report number handed out; the next report gets this plus one. */
    reportSeq: integer("report_seq").notNull().default(1000),
    suspendedAt: timestamp("suspended_at", { withTimezone: true }),
    suspendedReason: text("suspended_reason"),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Session resolution reads the signed-in user's tenant before any scope
    // exists, and the row holds no end user data, so reads are open. Writes
    // are not: a tenant may update only its own row (counters), staff any.
    pgPolicy("tenants_read", { for: "select", using: sql`true` }),
    pgPolicy("tenants_tenant_update", {
      for: "update",
      using: sql`${table.id} = ${CURRENT_TENANT}`,
      withCheck: sql`${table.id} = ${CURRENT_TENANT}`,
    }),
    pgPolicy("tenants_staff_write", {
      for: "all",
      using: STAFF_SCOPE,
      withCheck: STAFF_SCOPE,
    }),
  ]
)

/** Customer-owned rows disappear with their tenant. */
const tenantId = () =>
  text("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" })

/* -------------------------------------------------------------------------- */
/* Row level security                                                          */
/*                                                                             */
/* Policies read the session settings that src/db/scope.ts sets on a           */
/* connection. With none set, `nullif(..., '')` is null and no row matches,    */
/* so an unscoped query sees nothing. The migrations also FORCE row security   */
/* so the policies bind the table owner too; drizzle-kit does not model that.  */
/* -------------------------------------------------------------------------- */

/** Rows are visible and writable only on a connection bound to their tenant. */
const tenantIsolation = (table: string, column: AnyPgColumn) =>
  pgPolicy(`${table}_tenant_isolation`, {
    for: "all",
    using: sql`${column} = ${CURRENT_TENANT}`,
    withCheck: sql`${column} = ${CURRENT_TENANT}`,
  })

/**
 * Super admins setting up and managing accounts. Staff manage accounts but
 * never see or change what is in them, so each grant is the narrowest one the
 * admin console needs: list an account's apps, create the first app and
 * branding row with the account, and write (and read back) their own audit
 * entries. Nothing on end user tables, and no update or delete anywhere but
 * the tenants row itself. Deleting a tenant still removes everything it owns:
 * foreign key cascades are not subject to row level security.
 */
const staffRead = (table: string, using: SQL = STAFF_SCOPE) =>
  pgPolicy(`${table}_staff_read`, { for: "select", using })

const staffInsert = (table: string) =>
  pgPolicy(`${table}_staff_insert`, { for: "insert", withCheck: STAFF_SCOPE })

/** A credential being resolved by hash before its tenant is known. */
const lookupAccess = (table: string) =>
  pgPolicy(`${table}_lookup_access`, { for: "select", using: LOOKUP_SCOPE })

/* -------------------------------------------------------------------------- */
/* Apps: the products a customer connects                                      */
/* -------------------------------------------------------------------------- */

/**
 * One of a customer's apps. Everything an app sends (events, end users,
 * reports) and the credentials it sends with (API keys, RevenueCat) belong to
 * exactly one app. The team's own things (tasks, branding, Discord, webhooks,
 * Sideshift) belong to the account.
 *
 * Billing adds MAU across all of an account's apps, so pricing is per account.
 */
export const apps = pgTable(
  "apps",
  {
    id: text("id").primaryKey(),
    tenantId: tenantId(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    status: appStatusEnum("status").notNull().default("active"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("apps_tenant_id_slug_idx").on(table.tenantId, table.slug),
    // Lets app-scoped tables reference (tenant_id, app_id) as a pair, so a
    // row can never point at another tenant's app.
    unique("apps_tenant_id_id_unique").on(table.tenantId, table.id),
    tenantIsolation("apps", table.tenantId),
    staffRead("apps"),
    staffInsert("apps"),
    // An API key's app status is read in the same lookup as the key.
    lookupAccess("apps"),
  ]
)

const appId = () => text("app_id").notNull()

/** The composite reference every app-scoped table carries. */
const appReference = (table: { tenantId: AnyPgColumn; appId: AnyPgColumn }) =>
  foreignKey({
    columns: [table.tenantId, table.appId],
    foreignColumns: [apps.tenantId, apps.id],
  }).onDelete("cascade")

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

    // Null only for super admins, who belong to Yak rather than a customer.
    tenantId: text("tenant_id").references(() => tenants.id, {
      onDelete: "cascade",
    }),

    // Authorization
    role: userRoleEnum("role").notNull().default("member"),
    permissions: jsonb("permissions").$type<string[]>().notNull().default([]),

    // Invite / credential lifecycle
    mustChangePassword: boolean("must_change_password")
      .notNull()
      .default(false),
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
  (table) => [
    index("user_role_idx").on(table.role),
    index("user_tenant_id_idx").on(table.tenantId),
    // Compared as text so the migration that adds `super_admin` to the enum
    // can also add this check in the same transaction.
    check(
      "user_tenant_matches_role",
      sql`(${table.role}::text = 'super_admin') = (${table.tenantId} is null)`
    ),
  ]
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
    // Null for super admin actions, which belong to no customer.
    tenantId: text("tenant_id").references(() => tenants.id, {
      onDelete: "cascade",
    }),
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
    index("activity_log_tenant_id_created_at_idx").on(
      table.tenantId,
      table.createdAt
    ),
    tenantIsolation("activity_log", table.tenantId),
    // Only staff's own entries: a customer's trail describes their data.
    staffRead("activity_log", sql`${STAFF_SCOPE} and ${table.section} = 'admin'`),
    staffInsert("activity_log"),
  ]
)

/* -------------------------------------------------------------------------- */
/* Tasks: sprints, tickets, ticket history                                     */
/* -------------------------------------------------------------------------- */

export const sprints = pgTable(
  "sprints",
  {
    id: text("id").primaryKey(),
    tenantId: tenantId(),
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
  },
  (table) => [
    index("sprints_tenant_id_idx").on(table.tenantId),
    tenantIsolation("sprints", table.tenantId),
  ]
)

export const tickets = pgTable(
  "tickets",
  {
    id: text("id").primaryKey(),
    tenantId: tenantId(),
    // Human facing identifier rendered as STAND-101 in the panel. Numbered per
    // tenant from `tenants.ticket_seq`.
    number: integer("number").notNull(),
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
    uniqueIndex("tickets_tenant_id_number_idx").on(
      table.tenantId,
      table.number
    ),
    index("tickets_sprint_id_idx").on(table.sprintId),
    index("tickets_assignee_id_idx").on(table.assigneeId),
    index("tickets_status_idx").on(table.status),
    tenantIsolation("tickets", table.tenantId),
  ]
)

export const ticketHistory = pgTable(
  "ticket_history",
  {
    id: text("id").primaryKey(),
    tenantId: tenantId(),
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
    index("ticket_history_tenant_id_created_at_idx").on(
      table.tenantId,
      table.createdAt
    ),
    tenantIsolation("ticket_history", table.tenantId),
  ]
)

/* -------------------------------------------------------------------------- */
/* Reports: customer service inbox fed by the public ingest API                */
/* -------------------------------------------------------------------------- */

export const reports = pgTable(
  "reports",
  {
    id: text("id").primaryKey(),
    tenantId: tenantId(),
    appId: appId(),
    // Numbered per tenant from `tenants.report_seq`, so numbers stay unique
    // across an account's apps.
    number: integer("number").notNull(),
    type: reportTypeEnum("type").notNull(),
    status: reportStatusEnum("status").notNull().default("open"),
    priority: reportPriorityEnum("priority").notNull().default("medium"),
    subject: text("subject").notNull(),
    body: text("body").notNull(),

    // Reporter identity as supplied by the integrating application.
    reporterName: text("reporter_name").notNull(),
    // Null when the app has no address for the reporter (phone sign-in).
    reporterEmail: text("reporter_email"),
    externalUserId: text("external_user_id"),

    // Null when the app did not say; never guessed.
    platform: platformEnum("platform"),
    appVersion: text("app_version"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),

    source: reportSourceEnum("source").notNull().default("api"),
    apiKeyId: text("api_key_id"),
    // Supplied by the integrator so a retried create returns the first report.
    idempotencyKey: text("idempotency_key"),
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
    uniqueIndex("reports_tenant_id_number_idx").on(
      table.tenantId,
      table.number
    ),
    uniqueIndex("reports_public_token_idx").on(table.publicToken),
    index("reports_app_type_status_idx").on(
      table.tenantId,
      table.appId,
      table.type,
      table.status
    ),
    index("reports_assignee_id_idx").on(table.assigneeId),
    index("reports_reporter_email_idx").on(table.reporterEmail),
    index("reports_updated_at_idx").on(table.updatedAt),
    index("reports_external_user_id_idx").on(table.externalUserId),
    uniqueIndex("reports_app_idempotency_key_idx").on(
      table.tenantId,
      table.appId,
      table.idempotencyKey
    ),
    appReference(table),
    tenantIsolation("reports", table.tenantId),
  ]
)

export const reportMessages = pgTable(
  "report_messages",
  {
    id: text("id").primaryKey(),
    tenantId: tenantId(),
    appId: appId(),
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
    appReference(table),
    tenantIsolation("report_messages", table.tenantId),
  ]
)

/* -------------------------------------------------------------------------- */
/* Analytics events ingested from the integrating application                  */
/* -------------------------------------------------------------------------- */

export const analyticsEvents = pgTable(
  "analytics_events",
  {
    id: text("id").primaryKey(),
    tenantId: tenantId(),
    appId: appId(),
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
    index("analytics_events_app_occurred_at_idx").on(
      table.tenantId,
      table.appId,
      table.occurredAt
    ),
    index("analytics_events_app_name_occurred_at_idx").on(
      table.tenantId,
      table.appId,
      table.name,
      table.occurredAt
    ),
    index("analytics_events_app_external_user_id_idx").on(
      table.tenantId,
      table.appId,
      table.externalUserId
    ),
    appReference(table),
    tenantIsolation("analytics_events", table.tenantId),
  ]
)

/* -------------------------------------------------------------------------- */
/* App users: end users of the integrating application                         */
/* -------------------------------------------------------------------------- */

export const appUsers = pgTable(
  "app_users",
  {
    id: text("id").primaryKey(),
    tenantId: tenantId(),
    appId: appId(),
    externalId: text("external_id").notNull(),
    name: text("name").notNull(),
    // Null for accounts with no address on file (phone sign-in).
    email: text("email"),
    avatarUrl: text("avatar_url"),
    // The integrating app's own plan name, lowercased. `free` means unpaid.
    plan: text("plan").notNull().default("free"),
    billingPeriod: appUserBillingPeriodEnum("billing_period")
      .notNull()
      .default("none"),
    // Null when the app did not say; never guessed.
    platform: platformEnum("platform"),
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
    uniqueIndex("app_users_app_external_id_idx").on(
      table.tenantId,
      table.appId,
      table.externalId
    ),
    index("app_users_app_email_idx").on(
      table.tenantId,
      table.appId,
      table.email
    ),
    index("app_users_app_name_idx").on(table.tenantId, table.appId, table.name),
    appReference(table),
    tenantIsolation("app_users", table.tenantId),
  ]
)

/* -------------------------------------------------------------------------- */
/* API keys for the public ingest API                                          */
/* -------------------------------------------------------------------------- */

export const apiKeys = pgTable(
  "api_keys",
  {
    id: text("id").primaryKey(),
    tenantId: tenantId(),
    /** The app this key sends data for. A key never spans apps. */
    appId: appId(),
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
    /** Most recent rejected request, so a failing integration is visible. */
    lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
    lastError: text("last_error"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("api_keys_key_hash_idx").on(table.keyHash),
    index("api_keys_prefix_idx").on(table.prefix),
    index("api_keys_app_idx").on(table.tenantId, table.appId),
    appReference(table),
    tenantIsolation("api_keys", table.tenantId),
    // Resolving a presented key by hash happens before its tenant is known.
    lookupAccess("api_keys"),
  ]
)

/* -------------------------------------------------------------------------- */
/* Settings: branding/theme, Discord, outbound webhooks                        */
/* -------------------------------------------------------------------------- */

/** One row per tenant. Staff create it with the account, hence their access. */
export const appSettings = pgTable(
  "app_settings",
  {
    tenantId: text("tenant_id")
      .primaryKey()
      .references(() => tenants.id, { onDelete: "cascade" }),
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
  },
  (table) => [
    tenantIsolation("app_settings", table.tenantId),
    staffInsert("app_settings"),
  ]
)

export const discordTriggers = pgTable(
  "discord_triggers",
  {
    tenantId: tenantId(),
    trigger: discordTriggerEnum("trigger").notNull(),
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
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.trigger] }),
    tenantIsolation("discord_triggers", table.tenantId),
  ]
)

export const webhookEndpoints = pgTable(
  "webhook_endpoints",
  {
    id: text("id").primaryKey(),
    tenantId: tenantId(),
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
  (table) => [
    index("webhook_endpoints_tenant_id_enabled_idx").on(
      table.tenantId,
      table.enabled
    ),
    tenantIsolation("webhook_endpoints", table.tenantId),
  ]
)

export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: text("id").primaryKey(),
    tenantId: tenantId(),
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
    tenantIsolation("webhook_deliveries", table.tenantId),
  ]
)

/* -------------------------------------------------------------------------- */
/* Provider integrations: outbound API keys Stand uses to read metrics         */
/* -------------------------------------------------------------------------- */

/**
 * One row per connected provider per app. The credential is write-only: it is
 * stored as AES-256-GCM ciphertext and only ever decrypted server side to call
 * the provider's API, so the panel can display connection state without ever
 * handing the key back to a browser.
 */
export const providerIntegrations = pgTable(
  "provider_integrations",
  {
    tenantId: tenantId(),
    appId: appId(),
    provider: integrationProviderEnum("provider").notNull(),
    apiKeyEncrypted: text("api_key_encrypted").notNull(),
    /** Non secret fragment shown in the UI, e.g. `sk_ab…9f21`. */
    apiKeyHint: text("api_key_hint").notNull(),
    /** Provider side scope the key resolved to, e.g. a RevenueCat project id. */
    externalId: text("external_id"),
    externalName: text("external_name"),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    lastError: text("last_error"),
    connectedByUserId: text("connected_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    connectedAt: timestamp("connected_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.appId, table.provider] }),
    appReference(table),
    tenantIsolation("provider_integrations", table.tenantId),
  ]
)

/* -------------------------------------------------------------------------- */
/* Dashboard: per user widget layout                                           */
/* -------------------------------------------------------------------------- */

export type DashboardWidgetConfig = {
  /** Instance id, so the same widget type can be added more than once. */
  id: string
  type: string
  options: Record<string, string | number | boolean>
  /**
   * Cell rectangle on the panel's 12 column board. Absent on layouts saved
   * before the board existed; the panel places those on load.
   */
  layout?: { x: number; y: number; w: number; h: number }
}

export const dashboardLayouts = pgTable(
  "dashboard_layouts",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => user.id, { onDelete: "cascade" }),
    tenantId: tenantId(),
    widgets: jsonb("widgets")
      .$type<DashboardWidgetConfig[]>()
      .notNull()
      .default([]),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [tenantIsolation("dashboard_layouts", table.tenantId)]
)

/* -------------------------------------------------------------------------- */
/* Sideshift: campaign analytics read over OAuth                               */
/* -------------------------------------------------------------------------- */

/**
 * Each tenant's Sideshift connection. Sideshift is reached
 * over OAuth rather than a pasted key, so this holds the OAuth client Yak
 * registered for itself, the founder's tokens, and the in-flight authorization
 * request. Every secret is AES-256-GCM ciphertext and never leaves the server.
 *
 * The client registration survives a disconnect so reconnecting does not
 * register a second client with Sideshift.
 */
export const sideshiftConnection = pgTable(
  "sideshift_connection",
  {
    tenantId: text("tenant_id")
      .primaryKey()
      .references(() => tenants.id, { onDelete: "cascade" }),
    status: sideshiftConnectionStatusEnum("status")
      .notNull()
      .default("disconnected"),

    clientId: text("client_id"),
    clientSecretEncrypted: text("client_secret_encrypted"),
    registrationAccessTokenEncrypted: text(
      "registration_access_token_encrypted"
    ),
    /** The callback the client was registered with; a new API_URL re-registers. */
    redirectUri: text("redirect_uri"),

    accessTokenEncrypted: text("access_token_encrypted"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", {
      withTimezone: true,
    }),
    refreshTokenEncrypted: text("refresh_token_encrypted"),
    scope: text("scope"),
    companyId: text("company_id"),
    companyName: text("company_name"),
    connectedByUserId: text("connected_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    connectedAt: timestamp("connected_at", { withTimezone: true }),

    /** SHA-256 of the pending `state`; the raw value only exists in the URL. */
    oauthStateHash: text("oauth_state_hash"),
    oauthVerifierEncrypted: text("oauth_verifier_encrypted"),
    oauthStartedAt: timestamp("oauth_started_at", { withTimezone: true }),
    oauthStartedByUserId: text("oauth_started_by_user_id"),
    /**
     * The authorization code Sideshift returned, held until the user who
     * clicked Connect confirms from their own signed-in panel session.
     */
    oauthCodeEncrypted: text("oauth_code_encrypted"),

    syncStartedAt: timestamp("sync_started_at", { withTimezone: true }),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    lastError: text("last_error"),
    lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
    /** Sideshift's `requestId` for the last failure, for their support. */
    lastErrorRequestId: text("last_error_request_id"),

    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    tenantIsolation("sideshift_connection", table.tenantId),
    // The OAuth callback finds its connection by state before it knows whose.
    lookupAccess("sideshift_connection"),
  ]
)

/** Every campaign Sideshift reports, and whether the founder tracks it. */
export const sideshiftCampaigns = pgTable(
  "sideshift_campaigns",
  {
    tenantId: tenantId(),
    id: text("id").notNull(),
    name: text("name").notNull(),
    status: text("status").notNull(),
    tracked: boolean("tracked").notNull().default(false),
    /** Set when the campaign stops appearing in Sideshift's list. */
    removedAt: timestamp("removed_at", { withTimezone: true }),
    /** Set once the daily history for this campaign has been backfilled. */
    historyBackfilledAt: timestamp("history_backfilled_at", {
      withTimezone: true,
    }),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.id] }),
    tenantIsolation("sideshift_campaigns", table.tenantId),
  ]
)

/**
 * Posts in tracked campaigns with their latest cumulative stats. A post can
 * belong to several campaigns, so membership is an array rather than a key.
 */
export const sideshiftPosts = pgTable(
  "sideshift_posts",
  {
    tenantId: tenantId(),
    id: text("id").notNull(),
    platform: text("platform").notNull(),
    creatorId: text("creator_id"),
    creatorHandle: text("creator_handle"),
    creatorName: text("creator_name"),
    title: text("title"),
    thumbnailUrl: text("thumbnail_url"),
    postUrl: text("post_url"),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true }),
    views: bigint("views", { mode: "number" }).notNull().default(0),
    likes: bigint("likes", { mode: "number" }).notNull().default(0),
    comments: bigint("comments", { mode: "number" }).notNull().default(0),
    shares: bigint("shares", { mode: "number" }).notNull().default(0),
    campaignIds: text("campaign_ids").array().notNull().default([]),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.id] }),
    index("sideshift_posts_campaign_ids_idx").using("gin", table.campaignIds),
    index("sideshift_posts_tenant_id_uploaded_at_idx").on(
      table.tenantId,
      table.uploadedAt
    ),
    tenantIsolation("sideshift_posts", table.tenantId),
  ]
)

/** Creator display identities, for names and avatars in the creators table. */
export const sideshiftCreators = pgTable(
  "sideshift_creators",
  {
    tenantId: tenantId(),
    id: text("id").notNull(),
    name: text("name").notNull(),
    avatarUrl: text("avatar_url"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.id] }),
    tenantIsolation("sideshift_creators", table.tenantId),
  ]
)

/** Views and engagement gained per campaign per day, summed from post deltas. */
export const sideshiftDaily = pgTable(
  "sideshift_daily",
  {
    tenantId: tenantId(),
    campaignId: text("campaign_id").notNull(),
    date: date("date", { mode: "string" }).notNull(),
    views: bigint("views", { mode: "number" }).notNull().default(0),
    likes: bigint("likes", { mode: "number" }).notNull().default(0),
    comments: bigint("comments", { mode: "number" }).notNull().default(0),
    shares: bigint("shares", { mode: "number" }).notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.campaignId, table.date] }),
    foreignKey({
      columns: [table.tenantId, table.campaignId],
      foreignColumns: [sideshiftCampaigns.tenantId, sideshiftCampaigns.id],
    }).onDelete("cascade"),
    tenantIsolation("sideshift_daily", table.tenantId),
  ]
)

/**
 * The same daily gains, kept per post so a creator's views can be charted on
 * their own. The dashboard's views-vs-revenue tile groups these by the post's
 * creator; `sideshift_daily` stays the campaign total.
 */
export const sideshiftPostDaily = pgTable(
  "sideshift_post_daily",
  {
    tenantId: tenantId(),
    postId: text("post_id").notNull(),
    campaignId: text("campaign_id").notNull(),
    date: date("date", { mode: "string" }).notNull(),
    views: bigint("views", { mode: "number" }).notNull().default(0),
    likes: bigint("likes", { mode: "number" }).notNull().default(0),
    comments: bigint("comments", { mode: "number" }).notNull().default(0),
    shares: bigint("shares", { mode: "number" }).notNull().default(0),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.postId, table.campaignId, table.date],
    }),
    foreignKey({
      columns: [table.tenantId, table.postId],
      foreignColumns: [sideshiftPosts.tenantId, sideshiftPosts.id],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.tenantId, table.campaignId],
      foreignColumns: [sideshiftCampaigns.tenantId, sideshiftCampaigns.id],
    }).onDelete("cascade"),
    index("sideshift_post_daily_tenant_id_campaign_date_idx").on(
      table.tenantId,
      table.campaignId,
      table.date
    ),
    tenantIsolation("sideshift_post_daily", table.tenantId),
  ]
)

/* -------------------------------------------------------------------------- */
/* Inferred types                                                              */
/* -------------------------------------------------------------------------- */

export type Tenant = typeof tenants.$inferSelect
export type PlanTier = Tenant["plan"]
export type App = typeof apps.$inferSelect
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
export type ProviderIntegration = typeof providerIntegrations.$inferSelect
export type DashboardLayout = typeof dashboardLayouts.$inferSelect
export type SideshiftConnection = typeof sideshiftConnection.$inferSelect
export type SideshiftCampaign = typeof sideshiftCampaigns.$inferSelect
export type SideshiftPost = typeof sideshiftPosts.$inferSelect

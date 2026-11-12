# API reference

Two surfaces:

- **Panel API** (`/api/*`) — session cookie auth, used by the admin frontend.
- **Ingest API** (`/api/v1/*`) — API key auth, used by the customer application.
  Documented separately in [INTEGRATION.md](INTEGRATION.md).

All responses are JSON. Success is `{ "data": … }`, sometimes with a `meta`
object. Errors are `{ "error": { code, message, details? } }`.

Paginated endpoints return:

```json
{
  "data": [ … ],
  "pagination": { "limit": 50, "offset": 0, "total": 128, "hasMore": true }
}
```

## Unauthenticated

| Method | Path | Description |
| --- | --- | --- |
| GET | `/health` | Liveness plus a database check. `503` if the database is unreachable. |
| GET | `/api/config` | Product name and password policy, for the login screen. The same for every tenant, since the login screen cannot know which one is signing in. |
| GET | `/api/sideshift/callback` | Sideshift's OAuth redirect. Authenticated by the one-time `state` from `POST /api/sideshift/connect`, not the session. Parks the authorization code and redirects to `APP_URL/marketing?sideshift=confirm&sideshift_state=…`, where the user who clicked Connect finishes with `POST /api/sideshift/complete`. On failure redirects to `APP_URL/marketing?sideshift=<outcome>`. |

## Auth (`/api/auth/*`, handled by Better Auth)

Exactly five Better Auth endpoints are reachable, matched on method and exact
path. Everything else Better Auth could serve (user updates, session lists,
its admin plugin) answers `404`, and the request is rebuilt server side so
`Host` and `X-Forwarded-*` headers cannot steer it elsewhere. Bodies over
16 KB get `413`.

| Method | Path | Description |
| --- | --- | --- |
| POST | `/api/auth/sign-in/email` | `{ email, password }`. Sets the session cookie. Rate limited per client IP as seen by the proxy. |
| POST | `/api/auth/sign-out` | Clears the session. |
| GET | `/api/auth/get-session` | Current session, or `null`. |
| POST | `/api/auth/request-password-reset` | `{ email, redirectTo }`. Always succeeds, so it cannot be used to enumerate accounts. |
| POST | `/api/auth/reset-password` | `{ token, newPassword }`. Revokes all other sessions. |

There is no sign-up endpoint. Accounts exist only by invitation.

## Tenancy, apps and isolation

`GET /api/me` also returns `isSuperAdmin` and `tenant` (`{ id, name, slug,
status }`, or `null` for a super admin).

An account (tenant) owns any number of **apps**. What an app sends through the
ingest API (events, end users, reports) and the credentials it sends with (API
keys, RevenueCat) belong to one app; the team's own things (tasks, branding,
Discord, webhooks, Sideshift) belong to the account. App level routes live
under `/api/apps/:appId/…`; `:appId` must be one of the signed-in account's
apps or the response is `404`, the same as for an id that does not exist.

Every route below `/api/me` and `/api/admin` acts on the signed-in user's own
tenant. Super admins get `403` on them, and so does everyone in a suspended
tenant. Underneath, each request runs on a database connection bound to its
tenant and Postgres row level security hides every other tenant's rows, so a
query that forgot a filter returns nothing rather than someone else's data.

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/branding` | The tenant's brand name, logo, colour, and default theme. Open to every user in the tenant. |

## Apps (`/api/apps`)

Any signed-in user can list apps; creating, renaming and archiving requires the
`owner` or `admin` role.

| Method | Path | Description |
| --- | --- | --- |
| GET | `/` | Every app, oldest first: `{ id, name, slug, status, archivedAt, createdAt, updatedAt }`. |
| POST | `/` | `{ name, slug? }`. The slug is derived from the name when omitted and is unique within the account. |
| GET | `/:appId` | One app plus `userCount` and `apiKeyCount`. |
| PATCH | `/:appId` | `{ name }`. The slug is fixed. |
| POST | `/:appId/archive` | The app's API keys stop accepting data and it leaves the switcher. Nothing is deleted. |
| POST | `/:appId/restore` | Undoes an archive. |

App level routes, all under `/api/apps/:appId`, are documented in their own
sections below: `/reports`, `/analytics`, `/kpis`, `/app-users`,
`/integrations`, `/api-keys`.

## Billing (`/api/billing`)

Requires the `owner` or `admin` role. Stripe is not connected yet, so this is
read only.

| Method | Path | Description |
| --- | --- | --- |
| GET | `/` | `plan` (the account's tier with its limits), `plans` (the whole ladder), `usage` (`currentMonthMau`, `previousMonthMau`, `billableMau`, `suggestedPlanId`), `hasPaymentMethod`, `paymentsEnabled`. |

MAU is one unique end user with at least one event in a UTC calendar month,
added up across all of the account's apps. `billableMau` is the peak of the
last two full months.

## Account management (`/api/admin`, super admins only)

Super admins set accounts up; they never see what an account's apps sent. The
staff database scope their requests run in can read account metadata (apps,
settings, activity) and nothing from the end user tables, so that holds even
if a route here were wrong.

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/admin/tenants` | Every account with `status`, `plan`, owners, user count, `appCount`, `apps` (`{ id, name, status }`), and last sign in. |
| POST | `/api/admin/tenants` | `{ name, slug, ownerName, ownerEmail }`. Creates the account, its first app (named after the account), and invites its owner. `meta` carries `inviteEmailSent` and `temporaryPassword`. |
| GET | `/api/admin/tenants/:id` | The account and its panel users. |
| PATCH | `/api/admin/tenants/:id` | `{ name }`. The slug is fixed. |
| PATCH | `/api/admin/tenants/:id/plan` | `{ plan }`, one of `free`, `starter`, `growth`, `pro`, `studio`, `scale`. Places the account on a tier by hand until Stripe drives it. |
| POST | `/api/admin/tenants/:id/suspend` | `{ reason? }`. Blocks the panel and ingest API; deletes nothing. |
| POST | `/api/admin/tenants/:id/reactivate` | Lifts a suspension. |
| DELETE | `/api/admin/tenants/:id` | `{ confirmSlug }`. Only while suspended. Deletes the account and everything it owns. |
| POST | `/api/admin/tenants/:id/users` | `{ name, email, role }`. Account recovery only: `403` while the account has an active owner, since owners add their own teammates from the panel and staff must never be able to sign in to a customer's account. Not held to the plan's seat limit. |
| POST | `/api/admin/tenants/:id/users/:userId/resend-invite` | Issues a fresh temporary password and emails it. `409` once the user has signed in; after that only the password reset email can change it. The password is never returned to staff; if the email fails, `meta.inviteEmailSent` is `false` and the invite is resent once email works. |
| GET | `/api/admin/super-admins` | Every super admin. |
| POST | `/api/admin/super-admins` | `{ name, email }`. Invites a super admin. |
| DELETE | `/api/admin/super-admins/:id` | Removes a super admin other than yourself. |

Emails are unique across all tenants, since sign in is by email alone. On
every invite and resend, `meta.temporaryPassword` is set only when the invite
email could not be sent; otherwise it is `null` and only the invitee ever sees
the password.

## Account (`/api/me`)

Reachable while a forced password change is pending; everything else is not.

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/me` | Profile, role, effective permissions, `mustChangePassword`. |
| PATCH | `/api/me` | `{ name }` |
| POST | `/api/me/password` | `{ currentPassword, newPassword }`. Clears the forced change and revokes other sessions. |
| PUT | `/api/me/avatar` | `{ imageId }` or `{ imageId: null }`. Verified against Cloudflare before saving. |
| GET | `/api/me/activity` | Your last 100 audit entries. |
| POST | `/api/me/logout` | Sign out. |

## Panel users (`/api/system-users`)

Reading requires the `user-management` permission. Writing additionally
requires the `owner` or `admin` role.

| Method | Path | Description |
| --- | --- | --- |
| GET | `/meta` | Role and permission catalog for the settings UI. |
| GET | `/` | All panel users. |
| GET | `/:id` | One user. |
| POST | `/` | Invite. `{ name, email, role, permissions }`. Emails a temporary password. `403` when the plan's admin seats are used up (Free has one). |
| PATCH | `/:id` | `{ name?, role?, permissions? }` |
| POST | `/:id/deactivate` | Bans the account and kills its sessions, freeing the seat. |
| POST | `/:id/reactivate` | Restores access. `403` when it would exceed the plan's seats. |
| POST | `/:id/resend-invite` | New temporary password, old sessions revoked. `409` once the user has signed in. |
| DELETE | `/:id` | Permanent. Owners cannot be deleted. |

Invite responses carry `meta.inviteEmailSent`, and `meta.temporaryPassword`
only when the email could not be sent, so the credential can still be handed
over by hand.

## Activity (`/api/activity`)

| Method | Path | Description |
| --- | --- | --- |
| GET | `/` | Audit log. Query: `limit`, `offset`, `userId`. |

## Tasks (`/api/tasks`)

Requires the `tasks` permission.

| Method | Path | Description |
| --- | --- | --- |
| GET | `/sprints` | All sprints. |
| POST | `/sprints` | `{ name, durationWeeks: 1 \| 2, startDate }`. End date is derived. |
| PATCH | `/sprints/:id` | Partial update; end date recalculated. |
| DELETE | `/sprints/:id` | Tickets fall back to the backlog rather than being deleted. |
| GET | `/tickets` | All tickets. |
| POST | `/tickets` | `{ title, description?, status?, priority?, sprintId?, assigneeId? }` |
| GET | `/tickets/:id` | One ticket. |
| PATCH | `/tickets/:id` | Partial update. Records history and fires the Discord status trigger. |
| DELETE | `/tickets/:id` | Delete. |
| GET | `/tickets/:id/history` | Change history for one ticket. |
| GET | `/history` | Recent history across the board, for hydrating the panel in one call. |

History is recorded for `title`, `description`, `status`, `priority`,
`sprintId`, and `assigneeId`, and only when the value actually changes.

## Reports (`/api/apps/:appId/reports`)

Requires the `reports` permission. Reports belong to the app whose API key
filed them; numbers are still unique across the account.

| Method | Path | Description |
| --- | --- | --- |
| GET | `/counts` | Open counts per type, for the inbox badges. |
| GET | `/` | Inbox. Query: `type`, `status`, `priority`, `assigneeId`, `unassigned`, `openOnly`, `search`, `limit`, `offset`. |
| GET | `/:id` | One report with its conversation. |
| PATCH | `/:id` | `{ status?, priority?, assigneeId? }`. Stamps `resolvedAt` on close, clears it on reopen. |
| POST | `/:id/messages` | `{ body, isInternal?, status? }`. Reply and optionally move the report in one call. |

Internal messages are excluded from everything the reporter can read.

## KPIs (`/api/apps/:appId/kpis`)

Requires the `kpis` permission. Everything is read from the app's connected
RevenueCat project and cached in process (overview one minute, charts five
minutes) to stay inside RevenueCat's 25 requests per minute budget. Nothing
here writes to RevenueCat.

| Method | Path | Description |
| --- | --- | --- |
| GET | `/overview` | Snapshot metrics plus a derived summary. `connected: false` with empty metrics when RevenueCat is not set up. |
| GET | `/trend?chart=&days=` | Time series for one chart. `days` 7 to 365; resolution is day, week, or month by window. |
| GET | `/charts` | Chart ids the trend endpoint accepts, with labels. |

Trend responses carry `available`. When it is false, `reason` is one of
`permission` (the key lacks `charts_metrics:charts:read`), `rate_limited`,
`unavailable` (RevenueCat answered without a readable series), or
`unreachable`, and `message` explains it in words the panel shows verbatim.

Chart ids are the panel's own (`active_subscriptions`, `new_customers`, …) and
are mapped to RevenueCat's chart names (`actives`, `customers_new`, …) on the
server so saved dashboard layouts stay stable.

## Sideshift (`/api/sideshift`)

Requires the `marketing` permission. Connecting, disconnecting and choosing
campaigns are owner/admin only. Campaign analytics are read from Sideshift's
Platform API over OAuth with the read-only `analytics:read` scope and kept in
local tables, so reads never wait on Sideshift.

There is no scheduler. Reading `status` or `analytics` starts a background sync
when the last one began over an hour ago. Every sync holds a Postgres advisory
lock, so concurrent viewers start at most one. A new campaign backfills 365
days of daily history; afterwards each sync re-reads the last 3 days. History
is kept per campaign per day and, so a creator's share can be charted, per post
per day.

| Method | Path | Description |
| --- | --- | --- |
| GET | `/status` | Connection state (`disconnected`, `connected`, `needs_reconnect`, `subscription_inactive`), last sync, whether one is running, last error, and every campaign with its `tracked` flag. |
| GET | `/analytics?campaign=&range=&sort=` | `campaign` is a tracked id or `all`; `range` is `7d`, `30d` or `all`; `sort` is `views` or `newest`. Returns summary cards, a daily series, creator rows and up to 60 posts. |
| GET | `/series?campaign=&days=&creators=` | Daily views for the dashboard's views-vs-revenue tile. `campaign` is a tracked id or `all`; `days` is 7–365; `creators` is up to 6 comma-separated creator `key`s from `/analytics`, each URI-encoded. Returns the campaign's daily views plus one daily series per creator, all on the same calendar. |
| POST | `/refresh` | Starts a sync now. `202`; `429` within a minute of the last one; `409` while the connection needs reconnecting. |
| PUT | `/campaigns` | `{ tracked: string[] }`. Owner/admin. Newly tracked campaigns sync immediately. |
| POST | `/connect` | Owner/admin. Registers this account with Sideshift on first use, then returns `{ authorizeUrl }` for the browser to open. |
| POST | `/complete` | Owner/admin. `{ state }` from the callback's redirect. Finishes the connection the callback parked; only the user who clicked Connect, in the same account, can. Answers `{ outcome }`: `connected`, `expired`, `busy`, or `error`. Single use. |
| DELETE | `/connection` | Owner/admin. Revokes the token at Sideshift and deletes all cached campaign data. |

Sideshift is connected per account, not per app: the OAuth grant is to a
Sideshift company, which is the founder's, and campaigns are not tied to one
of their apps.

With a `7d` or `30d` range, views and engagement are what was gained inside the
window, while posts and creators count what was posted inside it. With `all`,
every number is lifetime. Engagement is likes + comments + shares; engagement
rate is engagement ÷ views.

## Dashboard (`/api/dashboard`)

Any signed-in user. The layout is per user.

| Method | Path | Description |
| --- | --- | --- |
| GET | `/layout` | `{ widgets, updatedAt }`. `widgets` is null until the user saves a layout. |
| PUT | `/layout` | `{ widgets: [{ id, type, options, layout? }] }`, at most 24. Replaces the layout. |

`layout` is `{ x, y, w, h }` in cells on a 12 column board. Widget types and
option keys are defined by the panel; the server only checks shape and size.

## Analytic Events (`/api/apps/:appId/analytics`)

Requires the `analytics` permission. `days` defaults to 7, maximum 90. These
are events the app sends through the ingest API, not RevenueCat data.

| Method | Path | Description |
| --- | --- | --- |
| GET | `/summary?days=` | Totals, unique users, today's count, change vs the previous window, top event. |
| GET | `/trend?days=` | Daily series. Empty days are filled with zeros. |
| GET | `/top-events?days=&limit=` | Per-event counts, unique users, and change vs the previous window. |
| GET | `/names` | Distinct event names, for the filter dropdown. |
| GET | `/events?limit=&name=&search=&externalUserId=` | Live event stream. |

## App users (`/api/apps/:appId/app-users`)

Requires the `users` permission. End users are per app; the same person using
two of the account's apps appears under each.

| Method | Path | Description |
| --- | --- | --- |
| GET | `/?q=` | Search by name, email, or external id. An empty query returns the most recently added users. `meta.total` is the size of the whole roster. |
| GET | `/stats?days=` | Totals by status and by plan. `plans` is keyed by the app's own plan names; `paid` is everyone not on `free`. |
| GET | `/:externalId` | Profile plus full support history. |

## Settings (`/api/settings`)

Requires the `theme` permission.

| Method | Path | Description |
| --- | --- | --- |
| GET | `/theme` | Brand name, primary colour, default theme, signed logo URL. |
| PUT | `/theme` | `{ brandName?, primaryColor?, defaultTheme?, logoImageId? }` |

## Discord (`/api/discord`)

Reading needs the `discord` section permission. Changing or testing a trigger
also needs the owner or admin role, like every other integration credential,
because it decides where end user data is sent.

Requires the `discord` permission.

| Method | Path | Description |
| --- | --- | --- |
| GET | `/` | All four triggers with enabled state, a URL hint, last fire time, last error. |
| PUT | `/:trigger` | `{ enabled?, webhookUrl? }`. `null` clears the URL. |
| POST | `/:trigger/test` | Posts a real test message. |

Triggers: `new_user`, `new_support`, `new_subscription`,
`ticket_status_change`.

Webhook URLs are write-only. They are encrypted at rest and never returned to
the browser; the UI shows only a hint. Only genuine `discord.com` webhook URLs
are accepted.

## Integrations (`/api/apps/:appId/integrations`)

Connection state is readable by any signed-in user so the dashboard knows
which widgets can show data; writing a credential requires the `owner` or
`admin` role. RevenueCat is connected per app; the Sideshift entry in the list
reflects the account level connection.

| Method | Path | Description |
| --- | --- | --- |
| GET | `/` | Every provider with `connected`, and for owners and admins the key hint, project, and last error. |
| PUT | `/revenuecat` | `{ apiKey, projectId? }`. Verified against RevenueCat before it is stored encrypted. |
| POST | `/revenuecat/test` | Confirms the stored key still works. |
| DELETE | `/revenuecat` | Forgets the credential. |

## API keys (`/api/apps/:appId/api-keys`)

Requires the `owner` or `admin` role. A key belongs to one app and everything
sent with it lands there; an archived app's keys are refused.

| Method | Path | Description |
| --- | --- | --- |
| GET | `/scopes` | Available scopes with descriptions. |
| GET | `/` | The app's keys. Never includes the secret. Each carries `lastUsedAt`, plus `lastErrorAt` and `lastError` for the most recent rejected request. |
| POST | `/` | `{ name, scopes, expiresAt? }`. `meta.key` holds the plaintext, shown once. |
| POST | `/:id/revoke` | Revoke but keep the audit record. |
| DELETE | `/:id` | Delete entirely. |

## Webhook endpoints (`/api/webhook-endpoints`)

Requires the `owner` or `admin` role.

| Method | Path | Description |
| --- | --- | --- |
| GET | `/events` | Subscribable event names. |
| GET | `/` | Registered endpoints. |
| POST | `/` | `{ url, events, enabled? }`. `meta.secret` shown once. |
| PATCH | `/:id` | Partial update. |
| DELETE | `/:id` | Remove. |
| GET | `/:id/deliveries` | Last 50 delivery attempts. |

URLs must be https and are rejected if they resolve to a private address.

## Uploads (`/api/uploads`)

Any authenticated user.

| Method | Path | Description |
| --- | --- | --- |
| GET | `/status` | Whether Cloudflare R2 is configured. |
| POST | `/direct-upload` | `{ purpose, contentType, sizeBytes }` → `{ uploadUrl, imageId, method, headers }`. The type and exact size are signed into the URL (5 MB max). `branding` needs the `theme` permission. |

Flow: request a presigned upload URL, `PUT` the file straight to R2 from the
browser, then send the returned `imageId` (object key) to `PUT /api/me/avatar`
or `PUT /api/settings/theme`. Files never pass through this server. Reads go
through `GET /api/media/...`, which redirects to a short-lived signed GET.

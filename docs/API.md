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
| GET | `/api/config` | Tenant name and password policy, for the login screen. |

## Auth (`/api/auth/*`, handled by Better Auth)

| Method | Path | Description |
| --- | --- | --- |
| POST | `/api/auth/sign-in/email` | `{ email, password }`. Sets the session cookie. |
| POST | `/api/auth/sign-out` | Clears the session. |
| GET | `/api/auth/get-session` | Current session, or `null`. |
| POST | `/api/auth/request-password-reset` | `{ email, redirectTo }`. Always succeeds, so it cannot be used to enumerate accounts. |
| POST | `/api/auth/reset-password` | `{ token, newPassword }`. Revokes all other sessions. |

There is no sign-up endpoint. Accounts exist only by invitation.

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
| POST | `/` | Invite. `{ name, email, role, permissions }`. Emails a temporary password. |
| PATCH | `/:id` | `{ name?, role?, permissions? }` |
| POST | `/:id/deactivate` | Bans the account and kills its sessions. |
| POST | `/:id/reactivate` | Restores access. |
| POST | `/:id/resend-invite` | New temporary password, old sessions revoked. |
| DELETE | `/:id` | Permanent. Owners cannot be deleted. |

When email is not configured, invite responses include
`meta.temporaryPassword` so the credential can still be handed over.

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

## Reports (`/api/reports`)

Requires the `reports` permission.

| Method | Path | Description |
| --- | --- | --- |
| GET | `/counts` | Open counts per type, for the inbox badges. |
| GET | `/` | Inbox. Query: `type`, `status`, `priority`, `assigneeId`, `unassigned`, `openOnly`, `search`, `limit`, `offset`. |
| GET | `/:id` | One report with its conversation. |
| PATCH | `/:id` | `{ status?, priority?, assigneeId? }`. Stamps `resolvedAt` on close, clears it on reopen. |
| POST | `/:id/messages` | `{ body, isInternal?, status? }`. Reply and optionally move the report in one call. |

Internal messages are excluded from everything the reporter can read.

## KPIs (`/api/kpis`)

Requires the `kpis` permission. Everything is read from the connected
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

## Analytic Events (`/api/analytics`)

Requires the `analytics` permission. `days` defaults to 7, maximum 90. These
are events the customer application sends through the ingest API, not
RevenueCat data.

| Method | Path | Description |
| --- | --- | --- |
| GET | `/summary?days=` | Totals, unique users, today's count, change vs the previous window, top event. |
| GET | `/trend?days=` | Daily series. Empty days are filled with zeros. |
| GET | `/top-events?days=&limit=` | Per-event counts, unique users, and change vs the previous window. |
| GET | `/names` | Distinct event names, for the filter dropdown. |
| GET | `/events?limit=&name=&search=&externalUserId=` | Live event stream. |

## App users (`/api/app-users`)

Requires the `users` permission.

| Method | Path | Description |
| --- | --- | --- |
| GET | `/?q=` | Search by name, email, or external id. Empty query returns nothing. |
| GET | `/:externalId` | Profile plus full support history. |

## Settings (`/api/settings`)

Requires the `theme` permission.

| Method | Path | Description |
| --- | --- | --- |
| GET | `/theme` | Brand name, primary colour, default theme, signed logo URL. |
| PUT | `/theme` | `{ brandName?, primaryColor?, defaultTheme?, logoImageId? }` |

## Discord (`/api/discord`)

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

## API keys (`/api/api-keys`)

Requires the `owner` or `admin` role.

| Method | Path | Description |
| --- | --- | --- |
| GET | `/scopes` | Available scopes with descriptions. |
| GET | `/` | All keys. Never includes the secret. |
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
| POST | `/direct-upload` | `{ purpose, contentType }` → `{ uploadUrl, imageId, method, headers }` |

Flow: request a presigned upload URL, `PUT` the file straight to R2 from the
browser, then send the returned `imageId` (object key) to `PUT /api/me/avatar`
or `PUT /api/settings/theme`. Files never pass through this server. Reads go
through `GET /api/media/...`, which redirects to a short-lived signed GET.

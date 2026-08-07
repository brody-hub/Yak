# Integration guide

How an application sends support reports and analytics events into the panel.

Everything here uses the **ingest API** under `/api/v1`, authenticated with an
API key. This is separate from the panel API, which uses session cookies and is
only for the admin UI.

## 1. Create an API key

Sign in to the panel as an owner or admin, open **Settings → API keys**, and
create a key with the scopes you need.

| Scope | Grants |
| --- | --- |
| `reports:write` | Create reports, append reporter messages |
| `reports:read` | Read report status and conversation |
| `events:write` | Send analytics events |
| `users:write` | Create and update app users |

The key is shown **once**. It looks like `yak_live_xxxxxxxx…`.

Treat it as a server-side secret. Do not ship it in a mobile binary or a web
bundle — proxy through your own backend instead. Anyone holding the key can
write into your inbox and analytics.

## 2. Authenticate

Send the key on every request, either way:

```
Authorization: Bearer yak_live_xxxxxxxx
```

```
X-API-Key: yak_live_xxxxxxxx
```

## 3. File a report

`POST /api/v1/reports` — scope `reports:write`

```bash
curl -X POST https://your-api.up.railway.app/api/v1/reports \
  -H "Authorization: Bearer $YAK_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "bug",
    "subject": "App crashes when opening workout history",
    "body": "Tapping History on iOS 18 freezes then closes the app.",
    "priority": "high",
    "reporter": {
      "name": "Maya Chen",
      "email": "maya@example.com",
      "externalUserId": "u_1842"
    },
    "platform": "ios",
    "appVersion": "2.14.1",
    "metadata": { "device": "iPhone 15 Pro", "buildNumber": 4120 }
  }'
```

| Field | Required | Notes |
| --- | --- | --- |
| `type` | yes | `bug`, `suggestion`, `support`, or `report` |
| `subject` | yes | Up to 200 characters |
| `body` | yes | Up to 10,000 characters |
| `priority` | no | `urgent`, `high`, `medium`, `low`. Defaults to `medium` |
| `reporter.name` | yes | |
| `reporter.email` | yes | Links the report to the user's support history |
| `reporter.externalUserId` | no | Your own user id, if you have one |
| `platform` | no | `ios`, `android`, `web`. Defaults to `web` |
| `appVersion` | no | |
| `metadata` | no | Arbitrary JSON kept alongside the report |

The response includes a `token`:

```json
{
  "data": {
    "id": "0c0a…",
    "number": 1001,
    "token": "8Kd2mXq…",
    "status": "open",
    "messages": [ … ]
  }
}
```

Store the `token` against the submission. It is the handle for the two calls
below.

## 4. Check status and show replies

`GET /api/v1/reports/{token}` — scope `reports:read`

Returns the report with its full conversation, minus any internal notes the
support team left. Use it to build an in-app "my support requests" screen.

## 5. Let the user reply

`POST /api/v1/reports/{token}/messages` — scope `reports:write`

```json
{ "body": "Still happening on 2.14.2." }
```

A reply moves a report that was `waiting` back to `open`, so it resurfaces in
the team's inbox. Replying to a `closed` report returns `400`.

## 6. List a user's reports

`GET /api/v1/reports?email=maya@example.com` — scope `reports:read`

Accepts `email` or `externalUserId`, plus an optional `limit` (default 25).

## 7. Send analytics events

`POST /api/v1/events` — scope `events:write`

Single event:

```json
{
  "name": "purchase_completed",
  "userId": "u_1842",
  "userName": "Maya Chen",
  "platform": "ios",
  "appVersion": "2.14.1",
  "properties": { "product": "pro_annual", "price": 79.99 },
  "timestamp": "2026-08-06T21:14:00.000Z"
}
```

Batch, up to 200 per request:

```json
{ "events": [ { "name": "screen_viewed", "userId": "u_1842" }, … ] }
```

Rules worth knowing:

- `name` may contain letters, numbers, and `_ . : -` only.
- `properties` values must be strings, numbers, or booleans. Nested objects are
  rejected so the data stays queryable.
- `timestamp` is your client's clock. If it is more than a day in the future or
  more than 30 days old it is replaced with the receipt time, so one device
  with a bad clock cannot distort the charts.
- Success returns `202 Accepted` with `{ "data": { "accepted": n } }`.
- Validation is all-or-nothing per request: one bad event rejects the batch so
  you can fix and retry rather than silently lose data.

## 8. Sync your users

`PUT /api/v1/users` — scope `users:write`

Idempotent on `externalId`, so it is safe to call on every sign-in.

```json
{
  "externalId": "u_1842",
  "name": "Maya Chen",
  "email": "maya@example.com",
  "plan": "pro",
  "billingPeriod": "annual",
  "platform": "ios",
  "status": "active",
  "renewsAt": "2026-11-12T10:00:00.000Z"
}
```

This powers the panel's user search and the subscription details in the user
side panel. It also drives two Discord triggers: `new_user` on first insert,
and `new_subscription` when a user moves off the `free` plan.

## 9. Receive webhooks

Register an endpoint in **Settings → Webhooks**. You get a signing secret once,
of the form `whsec_…`.

Events: `report.created`, `report.updated`, `report.status_changed`,
`report.replied`, `report.resolved`.

Each delivery carries:

```
X-Yak-Event: report.status_changed
X-Yak-Delivery: 6f1c…
X-Yak-Timestamp: 1786000000
X-Yak-Signature: v1=<hex>
```

The signature is `HMAC-SHA256("{timestamp}.{rawBody}", secret)`. Verify it
against the raw body before parsing:

```ts
import { createHmac, timingSafeEqual } from "node:crypto"

function verify(rawBody: string, headers: Record<string, string>, secret: string) {
  const timestamp = headers["x-yak-timestamp"]
  const received = headers["x-yak-signature"].replace(/^v1=/, "")

  // Reject anything older than five minutes to blunt replay attempts.
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) {
    return false
  }

  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex")

  return timingSafeEqual(Buffer.from(expected), Buffer.from(received))
}
```

Respond `2xx` to acknowledge. Non-2xx retries up to three times with backoff;
`4xx` other than `429` is treated as permanent and is not retried. Delivery
history is visible in the panel.

## Errors

Every error uses the same envelope:

```json
{
  "error": {
    "code": "validation_error",
    "message": "Validation failed",
    "details": [{ "field": "reporter.email", "message": "Invalid email" }]
  }
}
```

| Status | Code | Meaning |
| --- | --- | --- |
| 400 | `bad_request` | Malformed request |
| 401 | `unauthorized` | Missing, invalid, revoked, or expired key |
| 403 | `forbidden` | Key lacks the required scope |
| 404 | `not_found` | Unknown token or id |
| 422 | `validation_error` | Body failed schema validation, see `details` |
| 429 | `rate_limited` | Slow down and retry |
| 500 | `internal_error` | Our fault. `requestId` is included for support |

## Rate limits

Keyed per API key, not per IP, so one integration cannot starve another.

| Endpoint group | Limit |
| --- | --- |
| Reports and users | 600 requests/minute |
| Events | 300 requests/minute (batch to raise effective throughput) |

Responses carry standard `RateLimit-*` headers.

# Deployment

The frontend (`yak`) and this backend (`yak-server`) are separate repositories
so each gets its own Railway service and deploy trigger. Pushing to one does
not rebuild the other.

## 1. Postgres

In your Railway project, add a **Postgres** database. Railway exposes
`DATABASE_URL`; reference it from this service rather than copying the value:

```
DATABASE_URL=${{Postgres.DATABASE_URL}}
```

If you connect over Railway's private network (`*.railway.internal`), set
`DATABASE_SSL=false`. Over the public proxy, leave it `true`.

## 2. Create the API service

Point a new Railway service at this repository. `railway.json` already sets:

- build: `npm ci && npm run build`
- start: `npm run db:migrate && npm start`
- health check: `/health`

Migrations run on every boot and are idempotent, so a deploy that adds a
migration applies it before serving traffic.

## 3. Environment variables

```bash
NODE_ENV=production
PORT=8080

API_URL=https://your-api.up.railway.app
APP_URL=https://your-panel.up.railway.app

DATABASE_URL=${{Postgres.DATABASE_URL}}
DATABASE_SSL=true

BETTER_AUTH_SECRET=<openssl rand -base64 32>
ENCRYPTION_KEY=<openssl rand -base64 32>

TENANT_NAME=Stand
TENANT_SLUG=stand

CLOUDFLARE_ACCOUNT_ID=…
CLOUDFLARE_EMAIL_API_TOKEN=…
EMAIL_FROM=no-reply@yourdomain.com
EMAIL_FROM_NAME=Stand

R2_ACCESS_KEY_ID=…
R2_SECRET_ACCESS_KEY=…
R2_BUCKET=yak-media
# R2_JURISDICTION=          # optional
# R2_URL_TTL=3600
```

`API_URL` and `APP_URL` must be exact, with no trailing slash. `APP_URL` is the
CORS allowlist and the base for links in invite and reset emails. Add preview
domains to `CORS_ORIGINS` as a comma-separated list.

**Do not rotate `ENCRYPTION_KEY` casually.** Stored Discord webhook URLs and
webhook signing secrets are encrypted with it and become unreadable if it
changes. Re-enter them in the panel after a rotation.

## 4. Frontend service

Deploy the `yak` repo as a second service with:

```bash
VITE_API_URL=https://your-api.up.railway.app
```

## 5. Bootstrap the first account

There is no sign-up. Once the API is live, run from the Railway shell:

```bash
npm run create:owner -- you@yourdomain.com "Your Name"
```

The temporary password is emailed. If email is not configured yet, the command
prints it. Signing in forces an immediate password change.

## Cloudflare Email Service

1. Enable Email Service and verify your sending domain (SPF, DKIM, DMARC).
2. Create an API token with email send permission.
3. Set `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_EMAIL_API_TOKEN`, `EMAIL_FROM`.

`EMAIL_FROM` must be on the verified domain. Without these, the server logs
what it would have sent and returns the temporary password in the invite
response instead, so local development still works.

## Cloudflare R2

1. Open **Storage & databases → R2** and create a bucket (e.g. `yak-media`).
   Leave it **private** (no public access).
2. R2 → **Manage R2 API Tokens** → create a token with **Object Read & Write**
   on that bucket. Copy the Access Key ID and Secret Access Key.
3. On the bucket → **Settings → CORS**, allow the panel origin to PUT:

```json
[
  {
    "AllowedOrigins": ["https://your-panel.up.railway.app"],
    "AllowedMethods": ["PUT", "GET", "HEAD"],
    "AllowedHeaders": ["Content-Type"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

4. Set on the `yak-server` Railway service:

```bash
CLOUDFLARE_ACCOUNT_ID=…
R2_ACCESS_KEY_ID=…
R2_SECRET_ACCESS_KEY=…
R2_BUCKET=yak-media
```

Uploads use short-lived presigned PUT URLs (browser → R2). Reads go through
`GET /api/media/...`, which 302s to a short-lived signed GET
(`R2_URL_TTL`, default one hour). Without these variables, avatars still work
via the inline data-URL fallback; theme logo upload requires R2.

## Cookies across two hosts

The panel and API sit on different hosts, so in production the session cookie
is issued `Secure`, `SameSite=None`, and partitioned. Two consequences:

- Both services must be served over HTTPS. Railway does this by default.
- The frontend must send `credentials: "include"` on every request. The
  generated API client already does.

If you move both onto subdomains of one registrable domain (`panel.example.com`
and `api.example.com`), you can switch to `SameSite=Lax` by setting
`crossSubDomainCookies` in `src/auth/auth.ts`, which is slightly stricter.

## Operations

- **Health**: `GET /health` returns `503` when Postgres is unreachable, so
  Railway will not route traffic to a broken instance.
- **Logs**: structured JSON via pino. Cookies, authorization headers, API keys,
  passwords, and webhook URLs are redacted.
- **Request tracing**: every response carries `X-Request-Id`, and 500s include
  the same id in the body.
- **Shutdown**: SIGTERM drains in-flight requests for up to 15 seconds before
  closing the pool, which avoids 502s during a deploy.

## Migrations

```bash
# after editing src/db/schema.ts
npm run db:generate
git add drizzle/
git commit -m "Add …"
```

The generated SQL is committed and applied on the next deploy. Never edit an
already-applied migration; add a new one.

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

### Two database roles

Tenant isolation is enforced by Postgres row level security on every customer
table. Superusers and roles with `BYPASSRLS` skip those policies entirely, and
Railway's default `postgres` user is a superuser, so the server must work as
a plain role.

**With only Railway's `postgres` user, this happens automatically.** When
`DATABASE_URL` logs in as a role that bypasses row level security, the
migration step creates a `yak_app` role (no login, `NOSUPERUSER NOBYPASSRLS`)
and grants it data access, and the server switches every connection to it at
startup. The boot log shows `connections switch role` and then
`database role "yak_app" is subject to row level security`. If the role
cannot be set up, the migration step fails before changing anything.

**In production the server refuses to start if the role it ends up working as
is a superuser or has `BYPASSRLS`.** Locally a superuser works with a boot
warning.

Separate login roles, below, are still the stronger setup: the server's
credentials then cannot alter tables at all.

Migrations are the exception: they alter tables and move data across tenants,
so they keep running as the owner.

1. Create the restricted role once, connected as the owner, choosing a strong
   password:

   ```bash
   psql "$DATABASE_URL" -v password="'<password>'" -f scripts/create-app-role.sql
   ```

   The script creates `yak_app` with `NOSUPERUSER NOBYPASSRLS`, grants it data
   access on every table, and sets default privileges so tables that later
   migrations create are covered too.

2. Point the two variables at the two roles:

   ```
   MIGRATION_DATABASE_URL=${{Postgres.DATABASE_URL}}
   DATABASE_URL=postgresql://yak_app:<password>@<same host>:<port>/<database>
   ```

   `npm run db:migrate` uses `MIGRATION_DATABASE_URL` when set and falls back
   to `DATABASE_URL` otherwise. The server only ever uses `DATABASE_URL`.

If Railway rotates the owner credentials, `MIGRATION_DATABASE_URL` follows
automatically as a reference; `yak_app`'s password does not change.

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

DATABASE_URL=postgresql://yak_app:<password>@<host>:<port>/<database>
MIGRATION_DATABASE_URL=${{Postgres.DATABASE_URL}}
DATABASE_SSL=true

BETTER_AUTH_SECRET=<openssl rand -base64 32>
ENCRYPTION_KEY=<openssl rand -base64 32>

APP_NAME=Yak
SUPER_ADMIN_EMAIL=you@yourdomain.com
SUPER_ADMIN_NAME=Your Name

CLOUDFLARE_ACCOUNT_ID=…
CLOUDFLARE_EMAIL_API_TOKEN=…
EMAIL_FROM=no-reply@yourdomain.com
EMAIL_FROM_NAME=Yak

R2_ACCESS_KEY_ID=…
R2_SECRET_ACCESS_KEY=…
R2_BUCKET=yak-media
# R2_JURISDICTION=          # optional
# R2_URL_TTL=3600

# Stripe, test mode until billing goes live (see below)
STRIPE_SECRET_KEY=sk_test_…
STRIPE_PUBLISHABLE_KEY=pk_test_…
STRIPE_WEBHOOK_SECRET=whsec_…
```

`API_URL` and `APP_URL` must be exact, with no trailing slash. `APP_URL` is the
CORS allowlist and the base for links in invite and reset emails. Add preview
domains to `CORS_ORIGINS` as a comma-separated list.

**Do not rotate `ENCRYPTION_KEY` casually.** Stored Discord webhook URLs,
webhook signing secrets, RevenueCat keys and Sideshift tokens are encrypted
with it and become unreadable if it changes. Re-enter them in the panel after
a rotation, and reconnect Sideshift from Settings → Integrations.

Each stored secret is also sealed to the account (and app) it belongs to, so a
ciphertext copied into another account's row fails to decrypt there. Secrets
written before this existed still decrypt and are re-sealed the next time
their row is saved.

**`NODE_ENV` must be set explicitly** (`production` on Railway). The server
refuses to start without it, so a forgotten variable cannot silently turn on
development behaviour. Rate limits are always on; `RATE_LIMIT_DISABLED=true`
is honoured only outside production.

**Sideshift** needs no variables. Each account's first Connect click registers
that account with Sideshift as its own OAuth client whose callback is
`API_URL/api/sideshift/callback`, so `API_URL` must be the public HTTPS
address. If `API_URL` changes later, the next Connect registers again.
`SIDESHIFT_URL` exists only to point at a mock in tests; leave it unset.

**Stripe** bills the paid tiers. Use **test mode** keys everywhere except
production; a live secret key (`sk_live_`) is refused unless
`NODE_ENV=production`, and the publishable key must be from the same mode as
the secret key. Treat `STRIPE_SECRET_KEY` like `ENCRYPTION_KEY`: Railway
variables only, never in a repository. To set it up, in this order:

1. Set `STRIPE_SECRET_KEY` and `STRIPE_PUBLISHABLE_KEY` (Developers → API
   keys) and deploy.
2. Run `npm run stripe:sync-prices` from the Railway shell. It creates a
   product per paid tier and its monthly and annual prices from
   `src/billing/plans.ts`, under lookup keys like `yak_growth_monthly`. Run it
   again whenever prices in `plans.ts` change.
3. Developers → Webhooks → Add endpoint: `API_URL/api/stripe/webhook`, with
   events `checkout.session.completed`, `customer.subscription.created`,
   `customer.subscription.updated`, `customer.subscription.deleted`,
   `customer.subscription.paused`, `customer.subscription.resumed` and
   `invoice.payment_failed`. Set its signing secret as
   `STRIPE_WEBHOOK_SECRET`. Checkout is only offered once all three keys are
   set.
4. Settings → Billing → Customer portal: allow switching between the Yak
   products, updating payment methods, and cancelling.

**Self-serve sign up** is off until `SIGNUP_ENABLED=true`, and in production
also needs email configured (new owners confirm their address before they can
sign in). Set up Stripe first if paid tiers should be offered at sign up;
without it, sign up offers Free only.

## 4. Frontend service

Deploy the `yak` repo as a second service with:

```bash
VITE_API_URL=https://your-api.up.railway.app
```

## 5. Bootstrap the first super admin

One deployment serves every customer account. Customers create their own
through `/signup` when it is enabled, and a **super admin** (Yak staff)
manages accounts from the admin console at `APP_URL/admin`.

With `SUPER_ADMIN_EMAIL` set, the first boot creates that super admin. The
email must not already sign in to a customer account (emails are unique across
all of Yak); if it does, the boot log says so and no super admin is created.
Or run from the Railway shell:

```bash
npm run create:super-admin -- you@yourdomain.com "Your Name"
```

The temporary password is emailed. If email is not configured yet, the boot log
or the command prints it. Signing in forces an immediate password change.

From the admin console a super admin creates an account (name, slug, and its
first owner, who gets an invite), sees its usage as counts (end users,
events, reports, API keys, last activity), sets its tier when it does not pay
through Stripe, and can suspend, reactivate, or delete it. Creating an account also
creates its first app, named after it; the owner renames it and adds more from
the panel. Suspending blocks the account's panel and ingest API immediately
without deleting anything. Super admins cannot open a customer's panel or read
its data: their requests run in a database scope that the row level security
policies only let list apps, create an account's first app and branding, and
write their own audit entries, never touch end user tables, and never change
anything inside an account. Usage counts come from a database function that
returns numbers only. Staff can add a login to an account only while nobody
has ever signed in to it.

To add an owner to an existing account from the shell:

```bash
npm run create:owner -- <account-slug> owner@example.com "Owner Name"
```

## Upgrading a single-customer deployment

Migration `0005_multi_tenant` moves an existing deployment's data into an
account with id and slug `default`, named after its brand, and keeps ticket
and report numbering where it left off. Existing users, API keys, and
integrations keep working unchanged. Then create a super admin as above.
Several old deployments are not merged automatically: each one migrates into
its own database.

Migration `0006_apps_and_row_security` then gives every account one app that
reuses the account's id, name and slug, adopts all ingest data (events, end
users, reports, API keys, RevenueCat) into it, and turns on row level security.
After it runs, follow [Two database roles](#two-database-roles) before the
next production deploy, or the server will refuse to start.

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

Customer tables `FORCE ROW LEVEL SECURITY`, which binds the table owner too.
Only a superuser or a `BYPASSRLS` role (Railway's default `postgres` user is
one) is exempt. The migration runner sets `row_security = off` on its
connection, so when the owner is a plain role a migration that would be
filtered fails with an error instead of silently touching no rows. If you hit
that, run migrations as a `BYPASSRLS` role. `drizzle-kit` models the policies
but not `FORCE`; a new customer table needs `ENABLE` and `FORCE` added to its
generated SQL by hand, following `0006_apps_and_row_security.sql`.

Expect `0006` to hold locks on `analytics_events` for the duration of its
backfill on a large database; run it in a maintenance window.

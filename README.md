# yak-server

Backend for the Stand admin panel. Node.js + TypeScript + Express on Postgres,
deployed independently of the frontend so each repo gets its own Railway
deploy trigger.

One deployed instance serves exactly one customer application.

## What it does

| Area | Summary |
| --- | --- |
| Auth | Invite-only email + password via Better Auth. No public sign-up. |
| Panel API | Session-cookie API for tasks, reports, analytics, users, settings. |
| Ingest API | API-key API the customer app calls to file reports and send events. |
| Webhooks | Outbound signed webhooks on report lifecycle events. |
| Discord | Fires configured Discord webhooks on four panel triggers. |
| Email | Invites and password resets through Cloudflare Email Service. |
| Media | Avatars and branding logos in Cloudflare R2 with presigned URLs. |
| KPIs | Read-only subscription metrics and charts from a connected RevenueCat project. |
| Dashboard | Per-user widget layout for the panel home page. |

RevenueCat is only ever read. The panel stores one secret key (encrypted) and
issues GET requests against the v2 Charts & Metrics API; nothing here writes
to, or alters, RevenueCat data.

## Local setup

```bash
npm install
cp .env.example .env
```

Fill in `.env`. At minimum you need `DATABASE_URL`, `BETTER_AUTH_SECRET`, and
`ENCRYPTION_KEY`. Generate the two secrets with:

```bash
openssl rand -base64 32   # BETTER_AUTH_SECRET
openssl rand -base64 32   # ENCRYPTION_KEY (must decode to exactly 32 bytes)
```

Then create the schema, seed sample data, and create the first account:

```bash
npm run db:migrate
npm run seed
npm run create:owner -- you@example.com "Your Name"
npm run dev
```

`create:owner` prints a temporary password when email is not configured. The
panel forces you to replace it on first sign in.

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Watch mode on `src/index.ts`. |
| `npm run build` | Compile to `dist/`. |
| `npm start` | Run the compiled server. |
| `npm run typecheck` | Types only, no emit. |
| `npm run db:generate` | Diff `src/db/schema.ts` into a new SQL migration. |
| `npm run db:migrate` | Apply pending migrations. |
| `npm run db:studio` | Browse the database. |
| `npm run seed` | Insert demo data. No-op if data already exists. |
| `npm run create:owner` | Bootstrap the first owner account. |

## Layout

```
src/
  app.ts            Express wiring: security, CORS, routers
  index.ts          Listener and graceful shutdown
  env.ts            Zod-validated environment, fails fast on boot
  auth/             Better Auth instance, roles, permission rules
  db/               Drizzle schema, pool, migration runner
  middleware/       Session, permissions, API keys, validation, errors
  routes/           Panel routers, plus routes/public for the ingest API
  services/         Cloudflare email + R2, Discord, webhooks, activity
  scripts/          Owner bootstrap and seeding
```

## Authorization

Two independent axes, both enforced server side on every request:

- **Role** decides who can administer the panel. `owner` and `admin` can invite
  users and mint API keys; `member` cannot. Only an owner can modify another
  owner or grant the owner role, and the last owner cannot be demoted.
- **Permissions** decide which sections a user can reach: `dashboard`, `kpis`,
  `tasks`, `users`, `reports`, `analytics`, `user-management`, `theme`,
  `discord`. Owners and admins hold all of them implicitly.

The user row is re-read from the database on every request rather than trusted
from the session payload, so revoking access takes effect immediately.

## Security notes

- Sessions are httpOnly cookies. In production they are `Secure`, `SameSite=None`,
  and partitioned, because the panel and API sit on different Railway hosts.
- CORS is a strict allowlist built from `APP_URL` plus `CORS_ORIGINS`.
- API keys are stored only as SHA-256 hashes. The plaintext is shown once.
- Discord webhook URLs and outbound webhook secrets are encrypted at rest with
  AES-256-GCM using `ENCRYPTION_KEY`.
- Outbound webhook URLs are checked against private address ranges to prevent
  the panel being used to reach Railway's internal network.
- Rate limits apply per session user on the panel and per API key on ingest.
- Password reset revokes every other session for that account.

## Documentation

- [docs/INTEGRATION.md](docs/INTEGRATION.md) - how a customer app calls the ingest API
- [docs/API.md](docs/API.md) - full endpoint reference
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) - Railway and Cloudflare setup

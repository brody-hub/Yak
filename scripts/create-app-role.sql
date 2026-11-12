-- The role the API server connects as.
--
-- Tenant isolation rests on row level security, which superusers and roles
-- with BYPASSRLS skip entirely, so the server must not connect as the
-- database owner. This creates a plain login role with data access only.
-- Migrations keep running as the owner (MIGRATION_DATABASE_URL).
--
-- Run once as the owner, replacing the password:
--
--   psql "$MIGRATION_DATABASE_URL" -v password="'...'" -f scripts/create-app-role.sql
--
-- Then set DATABASE_URL to connect as yak_app.

CREATE ROLE yak_app LOGIN PASSWORD :password NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;

-- CONNECT on the database is granted to PUBLIC by default. If that has been
-- revoked, also run: GRANT CONNECT ON DATABASE <name> TO yak_app;
GRANT USAGE ON SCHEMA public TO yak_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO yak_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO yak_app;

-- Tables and sequences that later migrations create get the same grants, as
-- long as those migrations run as the role that executes this file.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO yak_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO yak_app;

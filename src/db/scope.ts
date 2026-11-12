import { AsyncLocalStorage } from "node:async_hooks"

import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres"
import type { Request, RequestHandler, Response } from "express"
import type { PoolClient } from "pg"

import { logger } from "../logger.js"
import { pool } from "./pool.js"
import * as schema from "./schema.js"

/**
 * Database scopes.
 *
 * Every customer-owned table has row level security keyed to three session
 * settings, so Postgres itself decides which rows a query can see:
 *
 * - `app.tenant_id`: the one customer this connection acts for. Set for panel
 *   sessions and API key requests. Rows of any other tenant do not exist.
 * - `app.staff`: a super admin at work. Opens only the tables account
 *   management needs (tenants' apps, settings, activity). End user data stays
 *   closed: the policies on those tables have no staff clause at all.
 * - `app.lookup`: a credential being resolved before its tenant is known (an
 *   API key by hash, a Sideshift OAuth state). Read only, two tables.
 *
 * A connection with none of them set sees no customer rows. That is what the
 * pool hands out, so a query that runs outside any scope fails closed.
 *
 * `withScope` leases one connection from the pool, sets the settings on it,
 * and runs `fn` with `db` bound to that connection through AsyncLocalStorage.
 * The settings are cleared before the connection goes back to the pool.
 */

export type Scope =
  { kind: "tenant"; tenantId: string } | { kind: "staff" } | { kind: "lookup" }

export type Database = NodePgDatabase<typeof schema>

type ScopeStore = {
  scope: Scope
  db: Database
  client: PoolClient
  released: boolean
}

const storage = new AsyncLocalStorage<ScopeStore>()

const APPLY_SETTINGS =
  "select set_config('app.tenant_id', $1, false), set_config('app.staff', $2, false), set_config('app.lookup', $3, false)"

const CLEAR_SETTINGS =
  "select set_config('app.tenant_id', '', false), set_config('app.staff', '', false), set_config('app.lookup', '', false)"

function settingsFor(scope: Scope): [string, string, string] {
  switch (scope.kind) {
    case "tenant":
      if (!scope.tenantId) {
        throw new Error("A tenant scope needs a tenant id")
      }
      return [scope.tenantId, "", ""]
    case "staff":
      return ["", "true", ""]
    case "lookup":
      return ["", "", "true"]
  }
}

async function lease(scope: Scope): Promise<ScopeStore> {
  const client = await pool.connect()

  try {
    await client.query(APPLY_SETTINGS, settingsFor(scope))
  } catch (error) {
    // The session is in an unknown state; do not let the pool reuse it.
    client.release(true)
    throw error
  }

  return {
    scope,
    db: drizzle(client, { schema }),
    client,
    released: false,
  }
}

/** pg's public view of whether the connection can take a new statement. */
type ClientState = {
  readyForQuery?: boolean
  getTransactionStatus?: () => "I" | "T" | "E" | null | undefined
}

/**
 * Returns the connection to the pool with its settings cleared, or destroys
 * it. Destroyed when asked (`discard`), or whenever a statement is still in
 * flight or a transaction is open: that can only mean a handler is still at
 * work while its request ended, and a transaction would roll back the cleared
 * settings and hand the next borrower this tenant.
 */
async function surrender(store: ScopeStore, discard = false) {
  if (store.released) {
    return
  }

  store.released = true

  const state = store.client as unknown as ClientState
  const inTransaction = (state.getTransactionStatus?.() ?? "I") !== "I"
  const busy = state.readyForQuery === false || inTransaction

  if (discard || busy) {
    store.client.release(true)
    return
  }

  try {
    await store.client.query(CLEAR_SETTINGS)
    store.client.release()
  } catch (error) {
    // A connection whose settings could not be cleared must not be reused:
    // the next borrower would inherit this tenant.
    logger.error({ err: error }, "Could not clear the database scope")
    store.client.release(true)
  }
}

/** The scope the current async context runs in, if any. */
export function currentScope(): Scope | null {
  return storage.getStore()?.scope ?? null
}

/** The tenant the current scope is bound to, or null. */
export function scopedTenantId(): string | null {
  const scope = currentScope()
  return scope?.kind === "tenant" ? scope.tenantId : null
}

/**
 * The `db` to use right now: the scoped connection when inside `withScope`,
 * otherwise the fallback. Throws once a request's scope has been released so
 * work that outlives its request cannot run on a connection that may already
 * belong to someone else.
 */
export function resolveDatabase(fallback: Database): Database {
  const store = storage.getStore()

  if (!store) {
    return fallback
  }

  if (store.released) {
    throw new Error(
      "The request's database scope has been released; open a new scope for background work"
    )
  }

  return store.db
}

/**
 * Runs `fn` on a connection bound to `scope`. Nest freely: an inner scope gets
 * its own connection and the outer one resumes afterwards. Background work
 * started from a request (webhooks, Discord, syncs) must open its own scope
 * this way rather than borrowing the request's.
 */
export async function withScope<T>(
  scope: Scope,
  fn: (db: Database) => Promise<T>
): Promise<T> {
  const store = await lease(scope)

  try {
    return await storage.run(store, () => fn(store.db))
  } finally {
    await surrender(store)
  }
}

export function withTenantScope<T>(
  tenantId: string,
  fn: (db: Database) => Promise<T>
): Promise<T> {
  return withScope({ kind: "tenant", tenantId }, fn)
}

export function withStaffScope<T>(
  fn: (db: Database) => Promise<T>
): Promise<T> {
  return withScope({ kind: "staff" }, fn)
}

export function withLookupScope<T>(
  fn: (db: Database) => Promise<T>
): Promise<T> {
  return withScope({ kind: "lookup" }, fn)
}

/**
 * Binds the rest of an Express request to `scope`. The connection is released
 * when the response closes, so handlers must not kick off database work that
 * outlives the response without opening a scope of their own.
 */
export async function enterRequestScope(
  req: Request,
  res: Response,
  scope: Scope,
  next: (error?: unknown) => void
): Promise<void> {
  if (storage.getStore()) {
    next(new Error("This request already has a database scope"))
    return
  }

  // Watched before leasing: a client that gives up while we wait for a
  // connection has already emitted `close`, and a listener added afterwards
  // would never fire, leaking the lease. (Only the response is watched: the
  // request stream reads as destroyed as soon as its body has been consumed.)
  let closed = res.closed
  res.once("close", () => {
    closed = true
  })

  let store: ScopeStore

  try {
    store = await lease(scope)
  } catch (error) {
    next(error)
    return
  }

  if (closed) {
    await surrender(store)
    return
  }

  req.dbScope = scope

  res.once("close", () => {
    // Closed before the response finished means the handler may still be
    // running, possibly inside a transaction: the connection is discarded.
    void surrender(store, !res.writableFinished)
  })

  storage.run(store, () => next())
}

/** Middleware form of enterRequestScope for a fixed scope. */
export function scopeRequests(scope: Scope): RequestHandler {
  return (req, res, next) => {
    void enterRequestScope(req, res, scope, next)
  }
}

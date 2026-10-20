import { and, between, eq, inArray, lt, sql } from "drizzle-orm"

import { db } from "../../db/index.js"
import {
  sideshiftCampaigns,
  sideshiftCreators,
  sideshiftDaily,
  sideshiftPosts,
  type SideshiftCampaign,
  type SideshiftConnection,
} from "../../db/schema.js"
import { logger } from "../../logger.js"
import { getResource, SideshiftError, type QueryValue } from "./client.js"
import {
  getAccessToken,
  loadConnection,
  recordFailure,
  updateConnection,
  withSideshiftLock,
} from "./connection.js"

/**
 * Keeps a local copy of the founder's Sideshift campaign analytics.
 *
 * There is no scheduler: reading the Marketing tab or the dashboard card
 * starts a sync in the background when the last one began over an hour ago,
 * and the page keeps showing the cached copy meanwhile. The Refresh button
 * skips the hour but not a one minute floor. Every sync holds the Postgres
 * advisory lock, so concurrent visitors start at most one.
 */

export const AUTO_SYNC_COOLDOWN_MS = 60 * 60_000
export const MANUAL_SYNC_COOLDOWN_MS = 60_000
/** A sync that has not finished after this long is assumed to have died. */
const SYNC_STALE_MS = 15 * 60_000

/** History pulled when a campaign is first tracked. The API caps one call at 366 days. */
const BACKFILL_DAYS = 365
/** Recent days re-read on every sync, since Sideshift keeps updating them. */
const INCREMENTAL_DAYS = 3
const PAGE_SIZE = 100
/** Safety stops. 100 pages is 10,000 posts per campaign. */
const MAX_POST_PAGES = 100
const MAX_LIST_PAGES = 50
/** Sideshift accepts at most 100 `programId` filters per call. */
const MAX_CAMPAIGN_FILTER = 100
const WRITE_CHUNK = 500

/** Campaign statuses that are not pre-selected when first seen. */
const INACTIVE_STATUSES = new Set([
  "archived",
  "ended",
  "closed",
  "completed",
  "draft",
  "paused",
  "deleted",
  "cancelled",
  "canceled",
])

export function isActiveStatus(status: string) {
  return !INACTIVE_STATUSES.has(status.trim().toLowerCase())
}

export function isSyncing(row: SideshiftConnection | undefined) {
  if (!row?.syncStartedAt) {
    return false
  }

  const started = row.syncStartedAt.getTime()

  return (
    Date.now() - started < SYNC_STALE_MS &&
    (!row.lastSyncedAt || row.lastSyncedAt.getTime() < started) &&
    (!row.lastErrorAt || row.lastErrorAt.getTime() < started)
  )
}

function startedWithin(row: SideshiftConnection, ms: number) {
  return Boolean(row.syncStartedAt && Date.now() - row.syncStartedAt.getTime() < ms)
}

/** Whether the Refresh button may start a sync right now. */
export function canRefreshNow(row: SideshiftConnection) {
  return !startedWithin(row, MANUAL_SYNC_COOLDOWN_MS)
}

/* -------------------------------------------------------------------------- */
/* Entry points                                                                */
/* -------------------------------------------------------------------------- */

/**
 * `auto` is a page view and respects the hour. `manual` is the Refresh button
 * and respects the minute. `immediate` follows a new connection or newly
 * picked campaigns: it ignores both and waits for a running sync to finish
 * rather than being skipped, so the new campaigns are not left empty.
 */
export type SyncTrigger = "auto" | "manual" | "immediate"

const IMMEDIATE_LOCK_WAIT_MS = 5 * 60_000

/**
 * Runs one sync if the trigger allows it and nobody else is syncing. Never
 * throws: failures are recorded on the connection for the Marketing tab.
 */
export async function runSync(trigger: SyncTrigger): Promise<"ran" | "skipped"> {
  const result = await withSideshiftLock(async () => {
    const row = await loadConnection()

    if (!row || row.status === "disconnected" || row.status === "needs_reconnect") {
      return "skipped" as const
    }

    if (trigger === "auto") {
      // A lapsed subscription pauses automatic syncing; Refresh still retries.
      if (
        row.status === "subscription_inactive" ||
        startedWithin(row, AUTO_SYNC_COOLDOWN_MS)
      ) {
        return "skipped" as const
      }
    }

    if (trigger === "manual" && !canRefreshNow(row)) {
      return "skipped" as const
    }

    const startedAt = new Date()
    await updateConnection({ syncStartedAt: startedAt })

    try {
      await syncAll(new Session(), startedAt)
      await updateConnection({
        status: "connected",
        lastSyncedAt: new Date(),
        lastError: null,
        lastErrorAt: null,
        lastErrorRequestId: null,
      })
      logger.info(
        { trigger, ms: Date.now() - startedAt.getTime() },
        "Sideshift sync complete"
      )
    } catch (error) {
      await recordFailure(error)
    }

    return "ran" as const
  }, { waitMs: trigger === "immediate" ? IMMEDIATE_LOCK_WAIT_MS : 0 })

  return result.acquired ? result.value : "skipped"
}

/** Fire and forget, for request handlers that must not wait on Sideshift. */
export function startSync(trigger: SyncTrigger) {
  void runSync(trigger).catch((error: unknown) => {
    logger.error({ err: error }, "Sideshift sync crashed")
  })
}

/* -------------------------------------------------------------------------- */
/* Authenticated session                                                       */
/* -------------------------------------------------------------------------- */

/** One sync's access token, refreshed once on a 401 before giving up. */
class Session {
  private token: string | null = null
  private retriedAfter401 = false

  async get(
    path: string,
    query?: Record<string, QueryValue>,
    accept?: string
  ): Promise<Response> {
    this.token ??= await getAccessToken()

    try {
      return await getResource(this.token, path, query, accept)
    } catch (error) {
      if (
        error instanceof SideshiftError &&
        error.status === 401 &&
        !this.retriedAfter401
      ) {
        this.retriedAfter401 = true
        this.token = await getAccessToken({ force: true })
        return getResource(this.token, path, query, accept)
      }

      throw error
    }
  }

  async json<T>(path: string, query?: Record<string, QueryValue>): Promise<T> {
    return (await (await this.get(path, query)).json()) as T
  }
}

/* -------------------------------------------------------------------------- */
/* Sync steps                                                                  */
/* -------------------------------------------------------------------------- */

async function syncAll(session: Session, startedAt: Date) {
  const campaigns = await syncCampaigns(session)
  await syncCreators(session)

  const tracked = campaigns.filter(
    (campaign) => campaign.tracked && !campaign.removedAt
  )
  const posts = await syncPosts(session, tracked, startedAt)
  await syncDaily(session, tracked, posts)
}

type CursorPage<T> = { data: T[]; nextCursor?: string | null; hasMore?: boolean }

/** Walks a cursor-paginated list endpoint to the end, within a page cap. */
async function listAll<T>(session: Session, path: string): Promise<T[]> {
  const items: T[] = []
  let cursor: string | null | undefined

  for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
    const body = await session.json<CursorPage<T>>(path, {
      limit: PAGE_SIZE,
      cursor,
    })

    items.push(...(body.data ?? []))
    cursor = body.nextCursor

    if (!body.hasMore || !cursor) {
      return items
    }
  }

  logger.warn({ path, count: items.length }, "Sideshift list truncated")
  return items
}

/**
 * Upserts Sideshift's campaign list. A campaign seen for the first time is
 * tracked when it looks active, so a fresh connection shows data straight
 * away. Afterwards the founder's own choice is never overwritten. Campaigns
 * that disappear from the list are flagged and dropped from tracking.
 */
async function syncCampaigns(session: Session): Promise<SideshiftCampaign[]> {
  const listed = await listAll<{ id: string; name: string; status: string }>(
    session,
    "/analytics/campaigns"
  )
  const now = new Date()

  for (let index = 0; index < listed.length; index += WRITE_CHUNK) {
    const chunk = listed.slice(index, index + WRITE_CHUNK)

    await db
      .insert(sideshiftCampaigns)
      .values(
        chunk.map((campaign) => ({
          id: campaign.id,
          name: campaign.name || "Untitled campaign",
          status: campaign.status || "unknown",
          tracked: isActiveStatus(campaign.status || ""),
          updatedAt: now,
        }))
      )
      .onConflictDoUpdate({
        target: sideshiftCampaigns.id,
        set: {
          name: sql`excluded.name`,
          status: sql`excluded.status`,
          removedAt: null,
          updatedAt: now,
        },
      })
  }

  const listedIds = new Set(listed.map((campaign) => campaign.id))
  const existing = await db.select().from(sideshiftCampaigns)
  const removed = existing
    .filter((campaign) => !listedIds.has(campaign.id) && !campaign.removedAt)
    .map((campaign) => campaign.id)

  if (removed.length > 0) {
    await db
      .update(sideshiftCampaigns)
      .set({ removedAt: now, tracked: false, historyBackfilledAt: null, updatedAt: now })
      .where(inArray(sideshiftCampaigns.id, removed))
    await db.delete(sideshiftDaily).where(inArray(sideshiftDaily.campaignId, removed))
  }

  return db.select().from(sideshiftCampaigns)
}

async function syncCreators(session: Session) {
  const creators = await listAll<{
    id: string
    name: string
    avatarUrl: string | null
  }>(session, "/analytics/creators")
  const now = new Date()

  for (let index = 0; index < creators.length; index += WRITE_CHUNK) {
    await db
      .insert(sideshiftCreators)
      .values(
        creators.slice(index, index + WRITE_CHUNK).map((creator) => ({
          id: creator.id,
          name: creator.name || "Unknown creator",
          avatarUrl: creator.avatarUrl ?? null,
          updatedAt: now,
        }))
      )
      .onConflictDoUpdate({
        target: sideshiftCreators.id,
        set: {
          name: sql`excluded.name`,
          avatarUrl: sql`excluded.avatar_url`,
          updatedAt: now,
        },
      })
  }
}

type VideoRow = {
  id?: string
  postId?: string
  title?: string | null
  platform?: string | null
  creator?: string | null
  contractorId?: string | null
  contractorName?: string | null
  views?: number | null
  likes?: number | null
  comments?: number | null
  shares?: number | null
  uploadedAt?: number | null
  uploadDate?: string | null
  postPage?: string | null
  thumbnail?: string | null
}

type VideoPage = {
  data?: VideoRow[]
  page?: number
  totalPages?: number
}

type PostRecord = typeof sideshiftPosts.$inferInsert & {
  /** The platform's own id, which the daily history may use instead of ours. */
  platformPostId: string | null
}

/** Sideshift documents epoch seconds but its examples show milliseconds. */
function toDate(epoch: number | null | undefined, fallback?: string | null) {
  if (typeof epoch === "number" && Number.isFinite(epoch) && epoch > 0) {
    return new Date(epoch > 1e12 ? epoch : epoch * 1_000)
  }

  if (fallback) {
    const parsed = new Date(fallback)
    return Number.isNaN(parsed.getTime()) ? null : parsed
  }

  return null
}

function count(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.round(value))
    : 0
}

/**
 * Re-reads every post in the tracked campaigns and replaces the local copy.
 * A post can sit in several campaigns, so membership is collected across all
 * of them before writing. Posts that left every tracked campaign are deleted.
 */
async function syncPosts(
  session: Session,
  tracked: SideshiftCampaign[],
  startedAt: Date
): Promise<Map<string, PostRecord>> {
  const posts = new Map<string, PostRecord>()

  for (const campaign of tracked) {
    for (let page = 1; page <= MAX_POST_PAGES; page += 1) {
      const body = await session.json<{ data?: VideoPage }>("/analytics/videos", {
        programId: campaign.id,
        page,
        limit: PAGE_SIZE,
        sortBy: "uploadedAt",
        sortOrder: "desc",
      })
      const envelope = body.data ?? {}
      const rows = envelope.data ?? []

      for (const row of rows) {
        const id = row.id ?? row.postId

        if (!id) {
          continue
        }

        const existing = posts.get(id)

        if (existing) {
          existing.campaignIds = Array.from(
            new Set([...(existing.campaignIds ?? []), campaign.id])
          )
          continue
        }

        posts.set(id, {
          id,
          platformPostId: row.postId ?? null,
          platform: row.platform || "unknown",
          creatorId: row.contractorId ?? null,
          creatorHandle: row.creator ?? null,
          creatorName: row.contractorName ?? null,
          title: row.title ?? null,
          thumbnailUrl: row.thumbnail ?? null,
          postUrl: row.postPage ?? null,
          uploadedAt: toDate(row.uploadedAt, row.uploadDate),
          views: count(row.views),
          likes: count(row.likes),
          comments: count(row.comments),
          shares: count(row.shares),
          campaignIds: [campaign.id],
        })
      }

      if (rows.length === 0 || page >= (envelope.totalPages ?? page)) {
        break
      }

      if (page === MAX_POST_PAGES) {
        logger.warn(
          { campaignId: campaign.id },
          "Sideshift campaign has more posts than one sync reads; the oldest are skipped"
        )
      }
    }
  }

  const records = Array.from(posts.values())
  const now = new Date()

  for (let index = 0; index < records.length; index += WRITE_CHUNK) {
    await db
      .insert(sideshiftPosts)
      .values(
        records
          .slice(index, index + WRITE_CHUNK)
          .map(({ platformPostId: _platformPostId, ...record }) => ({
            ...record,
            updatedAt: now,
          }))
      )
      .onConflictDoUpdate({
        target: sideshiftPosts.id,
        set: {
          platform: sql`excluded.platform`,
          creatorId: sql`excluded.creator_id`,
          creatorHandle: sql`excluded.creator_handle`,
          creatorName: sql`excluded.creator_name`,
          title: sql`excluded.title`,
          thumbnailUrl: sql`excluded.thumbnail_url`,
          postUrl: sql`excluded.post_url`,
          uploadedAt: sql`excluded.uploaded_at`,
          views: sql`excluded.views`,
          likes: sql`excluded.likes`,
          comments: sql`excluded.comments`,
          shares: sql`excluded.shares`,
          campaignIds: sql`excluded.campaign_ids`,
          updatedAt: now,
        },
      })
  }

  await db.delete(sideshiftPosts).where(lt(sideshiftPosts.updatedAt, startedAt))

  return posts
}

/* -------------------------------------------------------------------------- */
/* Daily history                                                               */
/* -------------------------------------------------------------------------- */

function utcDay(offsetDays: number) {
  const date = new Date()
  date.setUTCDate(date.getUTCDate() + offsetDays)
  return date.toISOString().slice(0, 10)
}

/**
 * Backfills a year for newly tracked campaigns and re-reads the last few days
 * for the rest.
 */
async function syncDaily(
  session: Session,
  tracked: SideshiftCampaign[],
  posts: Map<string, PostRecord>
) {
  // The history CSV may key rows by Sideshift's post id or the platform's.
  const lookup = new Map<string, PostRecord>()

  for (const record of posts.values()) {
    lookup.set(record.id, record)

    if (record.platformPostId) {
      lookup.set(record.platformPostId, record)
    }
  }

  const today = utcDay(0)
  const backfill = tracked.filter((campaign) => !campaign.historyBackfilledAt)
  const incremental = tracked.filter((campaign) => campaign.historyBackfilledAt)

  for (let index = 0; index < backfill.length; index += MAX_CAMPAIGN_FILTER) {
    const ids = backfill
      .slice(index, index + MAX_CAMPAIGN_FILTER)
      .map((campaign) => campaign.id)

    await syncHistory(session, ids, utcDay(-BACKFILL_DAYS), today, lookup)
    // Choosing campaigns does not wait for a running sync. Only marking ones
    // still tracked means a campaign dropped mid-sync backfills again if it is
    // picked later.
    await db
      .update(sideshiftCampaigns)
      .set({ historyBackfilledAt: new Date() })
      .where(
        and(
          inArray(sideshiftCampaigns.id, ids),
          eq(sideshiftCampaigns.tracked, true)
        )
      )
  }

  for (let index = 0; index < incremental.length; index += MAX_CAMPAIGN_FILTER) {
    const ids = incremental
      .slice(index, index + MAX_CAMPAIGN_FILTER)
      .map((campaign) => campaign.id)

    await syncHistory(session, ids, utcDay(-INCREMENTAL_DAYS), today, lookup)
  }
}

/** Minimal RFC 4180 parser: quoted fields, escaped quotes, CRLF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ""
  let quoted = false

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!

    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"'
          index += 1
        } else {
          quoted = false
        }
      } else {
        field += char
      }
      continue
    }

    if (char === '"') {
      quoted = true
    } else if (char === ",") {
      row.push(field)
      field = ""
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") {
        index += 1
      }
      row.push(field)
      rows.push(row)
      row = []
      field = ""
    } else {
      field += char
    }
  }

  if (field !== "" || row.length > 0) {
    row.push(field)
    rows.push(row)
  }

  return rows.filter((entry) => entry.some((value) => value !== ""))
}

const normalize = (header: string) => header.toLowerCase().replace(/[^a-z0-9]/g, "")

/**
 * Sideshift documents this export as "postId, date, cumulative
 * views/engagement, and daily deltas" without naming the columns, so they are
 * matched loosely by name. Only the daily deltas are used.
 */
function historyColumns(header: string[]) {
  const names = header.map(normalize)
  const find = (...candidates: string[]) => {
    const index = names.findIndex((name) => candidates.includes(name))
    return index === -1 ? null : index
  }

  return {
    post: find("postid", "id"),
    date: find("date", "day", "observeddate", "metricdate"),
    campaign: find("programid", "campaignid"),
    views: find("viewsdelta", "deltaviews", "viewschange", "dailyviews"),
    likes: find("likesdelta", "deltalikes", "likeschange", "dailylikes"),
    comments: find("commentsdelta", "deltacomments", "commentschange", "dailycomments"),
    shares: find("sharesdelta", "deltashares", "shareschange", "dailyshares"),
  }
}

type DailyTotals = { views: number; likes: number; comments: number; shares: number }

/**
 * Pulls the post-level daily history for some campaigns and replaces their
 * per-campaign daily totals for that date range.
 */
async function syncHistory(
  session: Session,
  campaignIds: string[],
  fromDate: string,
  toDate: string,
  lookup: Map<string, PostRecord>
) {
  const response = await session.get(
    "/analytics/posts/metrics-history",
    { fromDate, toDate, programId: campaignIds },
    "text/csv"
  )
  const [header, ...rows] = parseCsv(await response.text())

  if (!header) {
    throw new SideshiftError(
      200,
      "unexpected_format",
      "Sideshift returned an empty daily history"
    )
  }

  const columns = historyColumns(header)

  if (columns.post === null || columns.date === null || columns.views === null) {
    logger.error({ header }, "Unrecognised Sideshift metrics-history columns")
    throw new SideshiftError(
      200,
      "unexpected_format",
      "Sideshift's daily history came back in an unexpected format"
    )
  }

  const requested = new Set(campaignIds)
  const totals = new Map<string, DailyTotals>()
  const read = (row: string[], index: number | null) => {
    if (index === null) {
      return 0
    }

    const value = Number(row[index])
    // A post that is deleted or re-scraped can report a negative delta. The
    // chart shows gains, so those are floored rather than subtracted.
    return Number.isFinite(value) ? Math.max(0, value) : 0
  }

  for (const row of rows) {
    const date = (row[columns.date] ?? "").slice(0, 10)

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      continue
    }

    const csvCampaign = columns.campaign === null ? null : row[columns.campaign]
    const campaigns = csvCampaign
      ? [csvCampaign]
      : (lookup.get(row[columns.post] ?? "")?.campaignIds ?? [])

    for (const campaignId of campaigns) {
      if (!requested.has(campaignId)) {
        continue
      }

      const key = `${campaignId}|${date}`
      const entry = totals.get(key) ?? { views: 0, likes: 0, comments: 0, shares: 0 }

      entry.views += read(row, columns.views)
      entry.likes += read(row, columns.likes)
      entry.comments += read(row, columns.comments)
      entry.shares += read(row, columns.shares)
      totals.set(key, entry)
    }
  }

  const values = Array.from(totals, ([key, entry]) => {
    const [campaignId, date] = key.split("|") as [string, string]
    return { campaignId, date, ...entry }
  })

  await db.transaction(async (tx) => {
    await tx
      .delete(sideshiftDaily)
      .where(
        and(
          inArray(sideshiftDaily.campaignId, campaignIds),
          between(sideshiftDaily.date, fromDate, toDate)
        )
      )

    for (let index = 0; index < values.length; index += WRITE_CHUNK) {
      await tx.insert(sideshiftDaily).values(values.slice(index, index + WRITE_CHUNK))
    }
  })
}

/** Clears every cached campaign, post and daily row. */
export async function clearSideshiftCache() {
  await db.transaction(async (tx) => {
    await tx.delete(sideshiftDaily)
    await tx.delete(sideshiftPosts)
    await tx.delete(sideshiftCreators)
    await tx.delete(sideshiftCampaigns)
  })
}

/** Stops tracking campaigns and forgets their history so re-tracking backfills. */
export async function untrackCampaigns(ids: string[]) {
  if (ids.length === 0) {
    return
  }

  await db
    .update(sideshiftCampaigns)
    .set({ tracked: false, historyBackfilledAt: null, updatedAt: new Date() })
    .where(inArray(sideshiftCampaigns.id, ids))
  await db.delete(sideshiftDaily).where(inArray(sideshiftDaily.campaignId, ids))
}

export async function trackCampaigns(ids: string[]) {
  if (ids.length === 0) {
    return
  }

  await db
    .update(sideshiftCampaigns)
    .set({ tracked: true, updatedAt: new Date() })
    .where(and(inArray(sideshiftCampaigns.id, ids), eq(sideshiftCampaigns.tracked, false)))
}

import { and, arrayOverlaps, asc, eq, gte, inArray, isNull, sql } from "drizzle-orm"

import { db } from "../../db/index.js"
import {
  sideshiftCampaigns,
  sideshiftCreators,
  sideshiftDaily,
  sideshiftPosts,
} from "../../db/schema.js"
import { NotFoundError } from "../../lib/errors.js"
import { loadConnection } from "./connection.js"
import { canRefreshNow, isSyncing } from "./sync.js"

/**
 * Read models for the Marketing tab, built only from the local copy. Nothing
 * here calls Sideshift, so the tab loads at database speed.
 *
 * Engagement is likes + comments + shares, and engagement rate is engagement
 * divided by views. Both are computed here rather than taken from Sideshift
 * so every number on the tab uses the same definition.
 */

export type AnalyticsRange = "7d" | "30d" | "all"
export type PostSort = "views" | "newest"

const RANGE_DAYS: Record<Exclude<AnalyticsRange, "all">, number> = {
  "7d": 7,
  "30d": 30,
}

const POST_LIMIT = 60
const CREATOR_LIMIT = 100

function utcDay(offsetDays: number) {
  const date = new Date()
  date.setUTCDate(date.getUTCDate() + offsetDays)
  return date.toISOString().slice(0, 10)
}

function rate(engagement: number, views: number) {
  return views > 0 ? engagement / views : null
}

export async function trackedCampaigns() {
  return db
    .select()
    .from(sideshiftCampaigns)
    .where(
      and(eq(sideshiftCampaigns.tracked, true), isNull(sideshiftCampaigns.removedAt))
    )
    .orderBy(asc(sideshiftCampaigns.name))
}

/* -------------------------------------------------------------------------- */
/* Connection status                                                           */
/* -------------------------------------------------------------------------- */

export async function sideshiftStatus({ privileged }: { privileged: boolean }) {
  const row = await loadConnection()
  const status = row?.status ?? "disconnected"
  const campaigns =
    status === "disconnected"
      ? []
      : await db
          .select({
            id: sideshiftCampaigns.id,
            name: sideshiftCampaigns.name,
            status: sideshiftCampaigns.status,
            tracked: sideshiftCampaigns.tracked,
          })
          .from(sideshiftCampaigns)
          .where(isNull(sideshiftCampaigns.removedAt))
          .orderBy(asc(sideshiftCampaigns.name))

  return {
    status,
    connected: status !== "disconnected",
    companyId: row?.companyId ?? null,
    companyName: row?.companyName ?? null,
    connectedAt: row?.connectedAt?.toISOString() ?? null,
    lastSyncedAt: row?.lastSyncedAt?.toISOString() ?? null,
    syncing: isSyncing(row),
    canRefresh: Boolean(row && status !== "disconnected" && canRefreshNow(row)),
    lastError: row?.lastError ?? null,
    lastErrorAt: row?.lastErrorAt?.toISOString() ?? null,
    lastErrorRequestId: privileged ? (row?.lastErrorRequestId ?? null) : null,
    campaigns,
  }
}

export type SideshiftStatus = Awaited<ReturnType<typeof sideshiftStatus>>

/* -------------------------------------------------------------------------- */
/* Campaign analytics                                                          */
/* -------------------------------------------------------------------------- */

export async function campaignAnalytics(params: {
  campaign: string
  range: AnalyticsRange
  postSort: PostSort
}) {
  const tracked = await trackedCampaigns()
  let ids = tracked.map((campaign) => campaign.id)

  if (params.campaign !== "all") {
    if (!ids.includes(params.campaign)) {
      throw new NotFoundError("Tracked campaign")
    }

    ids = [params.campaign]
  }

  const since =
    params.range === "all" ? null : utcDay(-(RANGE_DAYS[params.range] - 1))

  if (ids.length === 0) {
    return {
      campaign: params.campaign,
      range: params.range,
      summary: {
        views: 0,
        engagement: 0,
        engagementRate: null,
        posts: 0,
        creators: 0,
        basis: since ? ("gained" as const) : ("total" as const),
      },
      daily: [],
      creators: [],
      posts: [],
    }
  }

  const posts = await db
    .select()
    .from(sideshiftPosts)
    .where(
      and(
        arrayOverlaps(sideshiftPosts.campaignIds, ids),
        since ? gte(sideshiftPosts.uploadedAt, new Date(`${since}T00:00:00Z`)) : undefined
      )
    )

  // With "all tracked campaigns", a post that sits in two of them is counted
  // once in the post totals but twice in the daily gains. That overlap is rare
  // enough on Sideshift that summing per campaign is the honest trade-off.
  const dailyRows = await db
    .select({
      date: sideshiftDaily.date,
      views: sql<string>`sum(${sideshiftDaily.views})`,
      engagement: sql<string>`sum(${sideshiftDaily.likes} + ${sideshiftDaily.comments} + ${sideshiftDaily.shares})`,
    })
    .from(sideshiftDaily)
    .where(
      and(
        inArray(sideshiftDaily.campaignId, ids),
        since ? gte(sideshiftDaily.date, since) : undefined
      )
    )
    .groupBy(sideshiftDaily.date)
    .orderBy(asc(sideshiftDaily.date))

  const daily = fillDays(
    dailyRows.map((row) => ({
      date: row.date,
      views: Number(row.views),
      engagement: Number(row.engagement),
    })),
    since
  )

  const engagementOf = (post: { likes: number; comments: number; shares: number }) =>
    post.likes + post.comments + post.shares

  const creatorKey = (post: (typeof posts)[number]) =>
    `${post.creatorId ?? post.creatorHandle ?? "unknown"}|${post.platform}`

  // Totals: the whole life of each post for "all time", or what was gained
  // inside the window otherwise, which is what the daily chart shows too.
  const summary = since
    ? {
        views: daily.reduce((sum, day) => sum + day.views, 0),
        engagement: daily.reduce((sum, day) => sum + day.engagement, 0),
      }
    : {
        views: posts.reduce((sum, post) => sum + post.views, 0),
        engagement: posts.reduce((sum, post) => sum + engagementOf(post), 0),
      }

  return {
    campaign: params.campaign,
    range: params.range,
    summary: {
      ...summary,
      engagementRate: rate(summary.engagement, summary.views),
      posts: posts.length,
      // People, not accounts: the creators table splits a creator by platform.
      creators: new Set(
        posts.map((post) => post.creatorId ?? post.creatorHandle ?? "unknown")
      ).size,
      basis: since ? ("gained" as const) : ("total" as const),
    },
    daily,
    creators: await buildCreators(posts, creatorKey, engagementOf),
    posts: [...posts]
      .sort((a, b) =>
        params.postSort === "newest"
          ? (b.uploadedAt?.getTime() ?? 0) - (a.uploadedAt?.getTime() ?? 0)
          : b.views - a.views
      )
      .slice(0, POST_LIMIT)
      .map((post) => ({
        id: post.id,
        title: post.title,
        platform: post.platform,
        creatorName: post.creatorName,
        creatorHandle: post.creatorHandle,
        thumbnailUrl: post.thumbnailUrl,
        postUrl: post.postUrl,
        uploadedAt: post.uploadedAt?.toISOString() ?? null,
        views: post.views,
        likes: post.likes,
        comments: post.comments,
        shares: post.shares,
      })),
  }
}

export type CampaignAnalytics = Awaited<ReturnType<typeof campaignAnalytics>>

/** One entry per day so the chart shows quiet days as zero, not as gaps. */
function fillDays(
  rows: { date: string; views: number; engagement: number }[],
  since: string | null
) {
  const start = since ?? rows[0]?.date

  if (!start) {
    return []
  }

  const byDate = new Map(rows.map((row) => [row.date, row]))
  const days: { date: string; views: number; engagement: number }[] = []
  const cursor = new Date(`${start}T00:00:00Z`)
  const end = utcDay(0)

  while (cursor.toISOString().slice(0, 10) <= end) {
    const date = cursor.toISOString().slice(0, 10)
    days.push(byDate.get(date) ?? { date, views: 0, engagement: 0 })
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }

  return days
}

/** One row per creator account (creator × platform) from the posts in scope. */
async function buildCreators<
  Post extends {
    creatorId: string | null
    creatorHandle: string | null
    creatorName: string | null
    platform: string
    views: number
    likes: number
    comments: number
    shares: number
  },
>(
  posts: Post[],
  keyOf: (post: Post) => string,
  engagementOf: (post: Post) => number
) {
  const groups = new Map<
    string,
    {
      creatorId: string | null
      handle: string | null
      name: string | null
      platform: string
      posts: number
      views: number
      engagement: number
    }
  >()

  for (const post of posts) {
    const key = keyOf(post)
    const group = groups.get(key) ?? {
      creatorId: post.creatorId,
      handle: post.creatorHandle,
      name: post.creatorName,
      platform: post.platform,
      posts: 0,
      views: 0,
      engagement: 0,
    }

    group.posts += 1
    group.views += post.views
    group.engagement += engagementOf(post)
    groups.set(key, group)
  }

  const creatorIds = Array.from(groups.values())
    .map((group) => group.creatorId)
    .filter((id): id is string => Boolean(id))

  const identities =
    creatorIds.length === 0
      ? []
      : await db
          .select()
          .from(sideshiftCreators)
          .where(inArray(sideshiftCreators.id, Array.from(new Set(creatorIds))))

  const byId = new Map(identities.map((identity) => [identity.id, identity]))

  return Array.from(groups, ([key, group]) => {
    const identity = group.creatorId ? byId.get(group.creatorId) : undefined

    return {
      key,
      name: identity?.name ?? group.name ?? group.handle ?? "Unknown creator",
      handle: group.handle,
      avatarUrl: identity?.avatarUrl ?? null,
      platform: group.platform,
      posts: group.posts,
      views: group.views,
      engagementRate: rate(group.engagement, group.views),
      averageViewsPerPost: group.posts > 0 ? group.views / group.posts : 0,
    }
  })
    .sort((a, b) => b.views - a.views)
    .slice(0, CREATOR_LIMIT)
}

import { eq } from "drizzle-orm"

import { db } from "../db/index.js"
import { providerIntegrations } from "../db/schema.js"
import { decryptSecret } from "../lib/crypto.js"
import {
  BadRequestError,
  RateLimitError,
  ServiceUnavailableError,
} from "../lib/errors.js"
import { logger } from "../logger.js"

const API_BASE = "https://api.revenuecat.com/v2"
const REQUEST_TIMEOUT_MS = 10_000

/**
 * RevenueCat allows 25 requests per minute against the Charts & Metrics
 * endpoints, which is easily exceeded by a dashboard several people have open.
 * Responses are cached in process for a minute; subscription metrics only
 * refresh on RevenueCat's side every few minutes anyway.
 */
const CACHE_TTL_MS = 60_000

type CacheEntry = { expiresAt: number; value: unknown }

const cache = new Map<string, CacheEntry>()

function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key)

  if (hit && hit.expiresAt > Date.now()) {
    return Promise.resolve(hit.value as T)
  }

  return load().then((value) => {
    cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, value })
    return value
  })
}

/** Dropped whenever the stored credential changes so stale data cannot leak. */
export function clearRevenueCatCache() {
  cache.clear()
}

/* -------------------------------------------------------------------------- */
/* Stored credential                                                          */
/* -------------------------------------------------------------------------- */

export type RevenueCatCredential = {
  apiKey: string
  projectId: string
}

/**
 * Reads and decrypts the stored key. Returns null when RevenueCat has not been
 * connected, which callers treat as "no data available" rather than an error.
 */
export async function loadRevenueCatCredential(): Promise<RevenueCatCredential | null> {
  const [row] = await db
    .select()
    .from(providerIntegrations)
    .where(eq(providerIntegrations.provider, "revenuecat"))
    .limit(1)

  if (!row?.externalId) {
    return null
  }

  try {
    return { apiKey: decryptSecret(row.apiKeyEncrypted), projectId: row.externalId }
  } catch (error) {
    // A rotated ENCRYPTION_KEY makes the ciphertext unreadable. Surface it as
    // disconnected so the operator is prompted to re-enter the key.
    logger.error({ err: error }, "Could not decrypt the RevenueCat API key")
    return null
  }
}

/* -------------------------------------------------------------------------- */
/* HTTP                                                                       */
/* -------------------------------------------------------------------------- */

async function revenueCatRequest<T>(
  apiKey: string,
  path: string,
  query?: Record<string, string | number | undefined>
): Promise<T> {
  const url = new URL(`${API_BASE}${path}`)

  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) {
      url.searchParams.set(key, String(value))
    }
  }

  let response: Response

  try {
    response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    logger.warn({ err: error, path }, "RevenueCat request failed")
    throw new ServiceUnavailableError("Could not reach RevenueCat")
  }

  if (response.status === 401 || response.status === 403) {
    throw new BadRequestError(
      "RevenueCat rejected the API key. Check that it is a secret v2 key with read access to metrics."
    )
  }

  if (response.status === 404) {
    throw new BadRequestError(
      "RevenueCat could not find that project. Reconnect the integration to pick it up again."
    )
  }

  if (response.status === 429) {
    throw new RateLimitError(
      "RevenueCat is rate limiting this project. Try again in a minute."
    )
  }

  if (!response.ok) {
    logger.warn(
      { status: response.status, path },
      "Unexpected RevenueCat response"
    )
    throw new ServiceUnavailableError("RevenueCat returned an unexpected error")
  }

  return (await response.json()) as T
}

/* -------------------------------------------------------------------------- */
/* Key validation                                                             */
/* -------------------------------------------------------------------------- */

export type RevenueCatProject = { id: string; name: string }

type ProjectListResponse = {
  items?: { id?: string; name?: string }[]
}

/**
 * Non secret fragment shown in the UI in place of the key.
 *
 * RevenueCat keys are long and prefixed (`sk_…`), so keeping the prefix plus the
 * last four characters is enough for an operator to tell two keys apart without
 * exposing anything usable.
 */
export function apiKeyHint(value: string): string {
  const trimmed = value.trim()

  if (trimmed.length <= 8) {
    return "•".repeat(8)
  }

  return `${trimmed.slice(0, 5)}…${trimmed.slice(-4)}`
}

/**
 * Confirms a key works and resolves which project it should read.
 *
 * Listing projects doubles as the credential check: it is the cheapest v2
 * endpoint a metrics-capable key can reach, and its result is what we need to
 * address every later request.
 */
export async function resolveProject(
  apiKey: string,
  requestedProjectId?: string
): Promise<RevenueCatProject> {
  const projects = await listProjects(apiKey)

  if (projects.length === 0) {
    throw new BadRequestError(
      "That key is valid but has no projects. Create a project in RevenueCat first."
    )
  }

  if (requestedProjectId) {
    const match = projects.find((project) => project.id === requestedProjectId)

    if (!match) {
      throw new BadRequestError(
        `This key cannot read project ${requestedProjectId}`
      )
    }

    return match
  }

  return projects[0] as RevenueCatProject
}

export async function listProjects(apiKey: string): Promise<RevenueCatProject[]> {
  const response = await revenueCatRequest<ProjectListResponse>(
    apiKey,
    "/projects",
    { limit: 20 }
  )

  return (response.items ?? []).flatMap((item) =>
    item.id ? [{ id: item.id, name: item.name ?? item.id }] : []
  )
}

/* -------------------------------------------------------------------------- */
/* Overview metrics                                                           */
/* -------------------------------------------------------------------------- */

type OverviewResponse = {
  metrics?: {
    id?: string
    name?: string
    description?: string
    unit?: string
    period?: string
    value?: number | null
    last_updated_at_iso8601?: string | null
  }[]
  currency?: string
}

export type RevenueCatMetric = {
  id: string
  name: string
  description: string | null
  /** `$` for money, `#` for counts, `%` for rates. */
  unit: string
  /** ISO 8601 duration the value covers, e.g. `P28D`. `P0D` means "right now". */
  period: string
  value: number | null
  lastUpdatedAt: string | null
}

export type RevenueCatOverview = {
  currency: string
  metrics: RevenueCatMetric[]
  fetchedAt: string
}

/**
 * The one call that backs every KPI tile: RevenueCat returns its whole overview
 * panel in a single response, so individual chart endpoints are never needed
 * just to fill in a stat card.
 */
export async function fetchOverview(
  credential: RevenueCatCredential
): Promise<RevenueCatOverview> {
  return cached(`overview:${credential.projectId}`, async () => {
    const response = await revenueCatRequest<OverviewResponse>(
      credential.apiKey,
      `/projects/${encodeURIComponent(credential.projectId)}/metrics/overview`
    )

    return {
      currency: response.currency ?? "USD",
      metrics: (response.metrics ?? []).flatMap((metric) =>
        metric.id
          ? [
              {
                id: metric.id,
                name: metric.name ?? metric.id,
                description: metric.description ?? null,
                unit: metric.unit ?? "#",
                period: metric.period ?? "P0D",
                value: typeof metric.value === "number" ? metric.value : null,
                lastUpdatedAt: metric.last_updated_at_iso8601 ?? null,
              },
            ]
          : []
      ),
      fetchedAt: new Date().toISOString(),
    }
  })
}

/* -------------------------------------------------------------------------- */
/* Charts (time series)                                                        */
/* -------------------------------------------------------------------------- */

export const REVENUECAT_CHARTS = [
  "revenue",
  "mrr",
  "active_subscriptions",
  "new_customers",
  "active_trials",
  "trials_conversion",
  "churned_subscriptions",
] as const

export type RevenueCatChartName = (typeof REVENUECAT_CHARTS)[number]

export function isRevenueCatChart(value: string): value is RevenueCatChartName {
  return (REVENUECAT_CHARTS as readonly string[]).includes(value)
}

export type RevenueCatSeries = {
  chart: RevenueCatChartName
  resolution: "day" | "week" | "month"
  points: { date: string; value: number }[]
}

type ChartResponse = {
  values?: { period?: string; date?: string; value?: number | null }[]
  data?: { period?: string; date?: string; value?: number | null }[]
}

/**
 * Time series for one RevenueCat chart.
 *
 * The charts API is less stable than the overview endpoint and is not available
 * on every plan, so callers get `null` instead of an exception when it cannot be
 * read; trend tiles then render an explanatory empty state rather than failing
 * the whole dashboard.
 */
export async function fetchChart(
  credential: RevenueCatCredential,
  chart: RevenueCatChartName,
  days: number
): Promise<RevenueCatSeries | null> {
  const resolution = days > 90 ? "month" : days > 31 ? "week" : "day"
  const key = `chart:${credential.projectId}:${chart}:${days}`

  return cached(key, async () => {
    const end = new Date()
    const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000)

    try {
      const response = await revenueCatRequest<ChartResponse>(
        credential.apiKey,
        `/projects/${encodeURIComponent(credential.projectId)}/charts/${chart}`,
        {
          resolution,
          start_time: start.toISOString(),
          end_time: end.toISOString(),
        }
      )

      const rows = response.values ?? response.data ?? []

      return {
        chart,
        resolution,
        points: rows.flatMap((row) => {
          const date = row.period ?? row.date

          return date
            ? [{ date: date.slice(0, 10), value: Number(row.value ?? 0) }]
            : []
        }),
      } satisfies RevenueCatSeries
    } catch (error) {
      logger.info(
        { err: error, chart },
        "RevenueCat chart data is unavailable for this project"
      )
      return null
    }
  })
}

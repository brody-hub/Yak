import type { PlanTier } from "../db/schema.js"

/**
 * The pricing ladder from "Yak Pricing: MAU Tiers" (October 28, 2026).
 *
 * Yak charges by monthly active users, added up across all of an account's
 * apps. Every tier has every module; they differ in MAU cap, admin seats, data
 * history and the events fair-use guardrail. Prices are in whole US dollars.
 *
 * These numbers are the plan's source of truth for the panel and the admin
 * console. Stripe prices, once created, must match them.
 *
 * The events guardrail is lower than the document's: about 100 events per MAU
 * at each tier's cap. At the document's limits, storing Studio's 200M events a
 * month for 36 months would cost more than the plan earns.
 */
export type Plan = {
  id: PlanTier
  name: string
  /** Inclusive upper bound on MAU; null for Scale, which is a conversation. */
  mauCap: number | null
  /** USD per month; null when custom. */
  monthlyPrice: number | null
  /** USD per year, two months free; null when custom. */
  annualPrice: number | null
  /** Panel logins; null means unlimited. */
  adminSeats: number | null
  /** Days of history the panel shows; null when custom. */
  historyDays: number | null
  /** Raw events per month before Yak gets in touch; null when custom. */
  eventsPerMonth: number | null
  support: "docs" | "email"
}

export const PLANS: readonly Plan[] = [
  {
    id: "free",
    name: "Free",
    mauCap: 500,
    monthlyPrice: 0,
    annualPrice: null,
    adminSeats: 1,
    historyDays: 90,
    eventsPerMonth: 50_000,
    support: "docs",
  },
  {
    id: "starter",
    name: "Starter",
    mauCap: 2_500,
    monthlyPrice: 39,
    annualPrice: 390,
    adminSeats: null,
    historyDays: 365,
    eventsPerMonth: 250_000,
    support: "email",
  },
  {
    id: "growth",
    name: "Growth",
    mauCap: 10_000,
    monthlyPrice: 99,
    annualPrice: 990,
    adminSeats: null,
    historyDays: 548,
    eventsPerMonth: 1_000_000,
    support: "email",
  },
  {
    id: "pro",
    name: "Pro",
    mauCap: 50_000,
    monthlyPrice: 249,
    annualPrice: 2_490,
    adminSeats: null,
    historyDays: 730,
    eventsPerMonth: 5_000_000,
    support: "email",
  },
  {
    id: "studio",
    name: "Studio",
    mauCap: 500_000,
    monthlyPrice: 549,
    annualPrice: 5_490,
    adminSeats: null,
    historyDays: 1_095,
    eventsPerMonth: 25_000_000,
    support: "email",
  },
  {
    id: "scale",
    name: "Scale",
    mauCap: null,
    monthlyPrice: null,
    annualPrice: null,
    adminSeats: null,
    historyDays: null,
    eventsPerMonth: null,
    support: "email",
  },
]

export const PLAN_IDS = PLANS.map((plan) => plan.id) as [
  PlanTier,
  ...PlanTier[],
]

export function getPlan(id: PlanTier): Plan {
  return PLANS.find((plan) => plan.id === id)!
}

/** The lowest tier whose cap covers `mau`. Scale when nothing else does. */
export function tierForMau(mau: number): Plan {
  return (
    PLANS.find((plan) => plan.mauCap !== null && mau <= plan.mauCap) ??
    getPlan("scale")
  )
}

/** Whether the plan can take one more panel seat. */
export function seatAvailable(plan: Plan, activeSeats: number): boolean {
  return plan.adminSeats === null || activeSeats < plan.adminSeats
}

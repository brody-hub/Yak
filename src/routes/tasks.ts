import { and, asc, desc, eq } from "drizzle-orm"
import { Router } from "express"
import { z } from "zod"

import { db } from "../db/index.js"
import {
  sprints,
  ticketHistory,
  tickets,
  user as userTable,
} from "../db/schema.js"
import { newId } from "../lib/crypto.js"
import { BadRequestError, NotFoundError } from "../lib/errors.js"
import {
  serializeSprint,
  serializeTicket,
  serializeTicketHistory,
} from "../lib/serializers.js"
import { getAuth, getTenantId } from "../middleware/auth.js"
import { validate } from "../middleware/validate.js"
import { recordActivity } from "../services/activity.js"
import { fireDiscordTrigger } from "../services/discord.js"
import { nextTicketNumber } from "../services/tenants.js"

export const tasksRouter: Router = Router()

const idParamSchema = z.object({ id: z.string().min(1) })

const statusSchema = z.enum(["backlog", "todo", "in_progress", "done"])
const prioritySchema = z.enum(["urgent", "high", "medium", "low"])

/** Fields whose changes are worth an entry in the ticket history panel. */
const TRACKED_FIELDS = [
  "title",
  "description",
  "status",
  "priority",
  "sprintId",
  "assigneeId",
] as const

const ticketUpdateSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(10_000).optional(),
    status: statusSchema.optional(),
    priority: prioritySchema.optional(),
    sprintId: z.string().min(1).nullable().optional(),
    assigneeId: z.string().min(1).nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "Provide at least one field to update",
  })

type TicketUpdate = z.infer<typeof ticketUpdateSchema>

/**
 * A sprint or assignee named in a request body has to belong to the caller's
 * tenant, or a ticket could be filed into another customer's sprint.
 */
async function assertReferences(
  tenantId: string,
  refs: { sprintId?: string | null; assigneeId?: string | null }
) {
  if (refs.sprintId) {
    const [sprint] = await db
      .select({ id: sprints.id })
      .from(sprints)
      .where(and(eq(sprints.id, refs.sprintId), eq(sprints.tenantId, tenantId)))
      .limit(1)

    if (!sprint) {
      throw new BadRequestError("That sprint does not exist")
    }
  }

  if (refs.assigneeId) {
    const [assignee] = await db
      .select({ id: userTable.id })
      .from(userTable)
      .where(
        and(
          eq(userTable.id, refs.assigneeId),
          eq(userTable.tenantId, tenantId)
        )
      )
      .limit(1)

    if (!assignee) {
      throw new BadRequestError("That assignee does not exist")
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Sprints                                                                     */
/* -------------------------------------------------------------------------- */

function sprintEndDate(startDate: Date, durationWeeks: number): Date {
  const end = new Date(startDate)
  end.setUTCDate(end.getUTCDate() + durationWeeks * 7 - 1)
  return end
}

tasksRouter.get("/sprints", async (req, res) => {
  const rows = await db
    .select()
    .from(sprints)
    .where(eq(sprints.tenantId, getTenantId(req)))
    .orderBy(asc(sprints.startDate))
  res.json({ data: rows.map(serializeSprint) })
})

tasksRouter.post(
  "/sprints",
  validate({
    body: z
      .object({
        name: z.string().trim().min(1).max(120),
        durationWeeks: z.union([z.literal(1), z.literal(2)]),
        startDate: z.coerce.date(),
      })
      .strict(),
  }),
  async (req, res) => {
    const { user } = getAuth(req)
    const tenantId = getTenantId(req)
    const body = req.body as {
      name: string
      durationWeeks: 1 | 2
      startDate: Date
    }

    const [row] = await db
      .insert(sprints)
      .values({
        id: newId(),
        tenantId,
        name: body.name,
        durationWeeks: body.durationWeeks,
        startDate: body.startDate,
        endDate: sprintEndDate(body.startDate, body.durationWeeks),
      })
      .returning()

    await recordActivity({
      tenantId,
      userId: user.id,
      action: "created",
      section: "tasks",
      summary: `Created ${body.name}`,
      ipAddress: req.ip,
    })

    res.status(201).json({ data: row ? serializeSprint(row) : null })
  }
)

tasksRouter.patch(
  "/sprints/:id",
  validate({
    params: idParamSchema,
    body: z
      .object({
        name: z.string().trim().min(1).max(120).optional(),
        durationWeeks: z.union([z.literal(1), z.literal(2)]).optional(),
        startDate: z.coerce.date().optional(),
      })
      .strict(),
  }),
  async (req, res) => {
    const { user } = getAuth(req)
    const tenantId = getTenantId(req)
    const id = req.params.id as string
    const body = req.body as {
      name?: string
      durationWeeks?: 1 | 2
      startDate?: Date
    }

    const [existing] = await db
      .select()
      .from(sprints)
      .where(and(eq(sprints.id, id), eq(sprints.tenantId, tenantId)))
      .limit(1)

    if (!existing) {
      throw new NotFoundError("Sprint")
    }

    const startDate = body.startDate ?? existing.startDate
    const durationWeeks = body.durationWeeks ?? existing.durationWeeks

    const [row] = await db
      .update(sprints)
      .set({
        ...(body.name ? { name: body.name } : {}),
        startDate,
        durationWeeks,
        endDate: sprintEndDate(startDate, durationWeeks),
        updatedAt: new Date(),
      })
      .where(and(eq(sprints.id, id), eq(sprints.tenantId, tenantId)))
      .returning()

    await recordActivity({
      tenantId,
      userId: user.id,
      action: "updated",
      section: "tasks",
      summary: `Updated ${row?.name ?? "sprint"}`,
      ipAddress: req.ip,
    })

    res.json({ data: row ? serializeSprint(row) : null })
  }
)

tasksRouter.delete(
  "/sprints/:id",
  validate({ params: idParamSchema }),
  async (req, res) => {
    const { user } = getAuth(req)
    const tenantId = getTenantId(req)
    const id = req.params.id as string

    const [existing] = await db
      .select()
      .from(sprints)
      .where(and(eq(sprints.id, id), eq(sprints.tenantId, tenantId)))
      .limit(1)

    if (!existing) {
      throw new NotFoundError("Sprint")
    }

    // Tickets survive the sprint; the foreign key nulls their sprintId so they
    // fall back into the backlog rather than disappearing.
    await db
      .delete(sprints)
      .where(and(eq(sprints.id, id), eq(sprints.tenantId, tenantId)))

    await recordActivity({
      tenantId,
      userId: user.id,
      action: "deleted",
      section: "tasks",
      summary: `Deleted ${existing.name}`,
      ipAddress: req.ip,
    })

    res.json({ data: { ok: true } })
  }
)

/* -------------------------------------------------------------------------- */
/* Tickets                                                                     */
/* -------------------------------------------------------------------------- */

tasksRouter.get("/tickets", async (req, res) => {
  const rows = await db
    .select()
    .from(tickets)
    .where(eq(tickets.tenantId, getTenantId(req)))
    .orderBy(desc(tickets.createdAt))
  res.json({ data: rows.map(serializeTicket) })
})

tasksRouter.post(
  "/tickets",
  validate({
    body: z
      .object({
        title: z.string().trim().min(1).max(200),
        description: z.string().trim().max(10_000).default(""),
        status: statusSchema.default("backlog"),
        priority: prioritySchema.default("medium"),
        sprintId: z.string().min(1).nullable().default(null),
        assigneeId: z.string().min(1).nullable().default(null),
      })
      .strict(),
  }),
  async (req, res) => {
    const { user } = getAuth(req)
    const body = req.body as {
      title: string
      description: string
      status: z.infer<typeof statusSchema>
      priority: z.infer<typeof prioritySchema>
      sprintId: string | null
      assigneeId: string | null
    }
    const tenantId = getTenantId(req)

    await assertReferences(tenantId, body)

    const row = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(tickets)
        .values({
          id: newId(),
          tenantId,
          number: await nextTicketNumber(tx, tenantId),
          title: body.title,
          description: body.description,
          status: body.status,
          priority: body.priority,
          sprintId: body.sprintId,
          assigneeId: body.assigneeId,
          createdByUserId: user.id,
        })
        .returning()

      if (!created) {
        throw new BadRequestError("Could not create ticket")
      }

      await tx.insert(ticketHistory).values({
        id: newId(),
        tenantId,
        ticketId: created.id,
        type: "created",
        actorId: user.id,
      })

      return created
    })

    await recordActivity({
      tenantId,
      userId: user.id,
      action: "created",
      section: "tasks",
      summary: `Created ticket ${body.title}`,
      metadata: { ticketId: row.id },
      ipAddress: req.ip,
    })

    res.status(201).json({ data: serializeTicket(row) })
  }
)

tasksRouter.get(
  "/tickets/:id",
  validate({ params: idParamSchema }),
  async (req, res) => {
    const [row] = await db
      .select()
      .from(tickets)
      .where(
        and(
          eq(tickets.id, req.params.id as string),
          eq(tickets.tenantId, getTenantId(req))
        )
      )
      .limit(1)

    if (!row) {
      throw new NotFoundError("Ticket")
    }

    res.json({ data: serializeTicket(row) })
  }
)

tasksRouter.patch(
  "/tickets/:id",
  validate({
    params: idParamSchema,
    body: ticketUpdateSchema,
  }),
  async (req, res) => {
    const { user } = getAuth(req)
    const tenantId = getTenantId(req)
    const id = req.params.id as string
    const body = req.body as TicketUpdate

    const [existing] = await db
      .select()
      .from(tickets)
      .where(and(eq(tickets.id, id), eq(tickets.tenantId, tenantId)))
      .limit(1)

    if (!existing) {
      throw new NotFoundError("Ticket")
    }

    await assertReferences(tenantId, body)

    // Diff before writing so the history reflects real transitions rather than
    // every field the client happened to send.
    const changes = TRACKED_FIELDS.filter((field) => {
      if (!(field in body)) {
        return false
      }

      return body[field] !== existing[field]
    })

    if (changes.length === 0) {
      res.json({ data: serializeTicket(existing) })
      return
    }

    const row = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(tickets)
        .set({ ...body, updatedAt: new Date() })
        .where(and(eq(tickets.id, id), eq(tickets.tenantId, tenantId)))
        .returning()

      if (!updated) {
        throw new NotFoundError("Ticket")
      }

      await tx.insert(ticketHistory).values(
        changes.map((field) => ({
          id: newId(),
          tenantId,
          ticketId: id,
          type: "updated" as const,
          field,
          fromValue:
            existing[field] === null ? null : String(existing[field] ?? ""),
          toValue: body[field] === null ? null : String(body[field] ?? ""),
          actorId: user.id,
        }))
      )

      return updated
    })

    await recordActivity({
      tenantId,
      userId: user.id,
      action: "updated",
      section: "tasks",
      summary: `Updated ticket ${row.title}`,
      metadata: { ticketId: row.id, fields: changes },
      ipAddress: req.ip,
    })

    if (changes.includes("status")) {
      const assignee = row.assigneeId
        ? await db
            .select({ name: userTable.name })
            .from(userTable)
            .where(
              and(
                eq(userTable.id, row.assigneeId),
                eq(userTable.tenantId, tenantId)
              )
            )
            .limit(1)
            .then((rows) => rows[0]?.name ?? null)
        : null

      void fireDiscordTrigger(tenantId, "ticket_status_change", {
        title: `Ticket #${row.number} moved to ${row.status}`,
        description: row.title,
        fields: [
          { name: "From", value: existing.status, inline: true },
          { name: "To", value: row.status, inline: true },
          { name: "Priority", value: row.priority, inline: true },
          { name: "Assignee", value: assignee ?? "Unassigned", inline: true },
          { name: "Changed by", value: user.name, inline: true },
        ],
      })
    }

    res.json({ data: serializeTicket(row) })
  }
)

tasksRouter.delete(
  "/tickets/:id",
  validate({ params: idParamSchema }),
  async (req, res) => {
    const { user } = getAuth(req)
    const tenantId = getTenantId(req)
    const id = req.params.id as string

    const [existing] = await db
      .select()
      .from(tickets)
      .where(and(eq(tickets.id, id), eq(tickets.tenantId, tenantId)))
      .limit(1)

    if (!existing) {
      throw new NotFoundError("Ticket")
    }

    await db
      .delete(tickets)
      .where(and(eq(tickets.id, id), eq(tickets.tenantId, tenantId)))

    await recordActivity({
      tenantId,
      userId: user.id,
      action: "deleted",
      section: "tasks",
      summary: `Deleted ticket ${existing.title}`,
      ipAddress: req.ip,
    })

    res.json({ data: { ok: true } })
  }
)

tasksRouter.get(
  "/tickets/:id/history",
  validate({ params: idParamSchema }),
  async (req, res) => {
    const rows = await db
      .select()
      .from(ticketHistory)
      .where(
        and(
          eq(ticketHistory.ticketId, req.params.id as string),
          eq(ticketHistory.tenantId, getTenantId(req))
        )
      )
      .orderBy(asc(ticketHistory.createdAt))

    res.json({ data: rows.map(serializeTicketHistory) })
  }
)

/** Whole-board history, used to hydrate the panel in one request. */
tasksRouter.get("/history", async (req, res) => {
  const rows = await db
    .select()
    .from(ticketHistory)
    .where(eq(ticketHistory.tenantId, getTenantId(req)))
    .orderBy(desc(ticketHistory.createdAt))
    .limit(500)

  res.json({ data: rows.map(serializeTicketHistory) })
})

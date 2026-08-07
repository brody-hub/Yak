import { asc, desc, eq } from "drizzle-orm"
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
import { getAuth } from "../middleware/auth.js"
import { validate } from "../middleware/validate.js"
import { recordActivity } from "../services/activity.js"
import { fireDiscordTrigger } from "../services/discord.js"

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

/* -------------------------------------------------------------------------- */
/* Sprints                                                                     */
/* -------------------------------------------------------------------------- */

function sprintEndDate(startDate: Date, durationWeeks: number): Date {
  const end = new Date(startDate)
  end.setUTCDate(end.getUTCDate() + durationWeeks * 7 - 1)
  return end
}

tasksRouter.get("/sprints", async (_req, res) => {
  const rows = await db.select().from(sprints).orderBy(asc(sprints.startDate))
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
    const body = req.body as {
      name: string
      durationWeeks: 1 | 2
      startDate: Date
    }

    const [row] = await db
      .insert(sprints)
      .values({
        id: newId(),
        name: body.name,
        durationWeeks: body.durationWeeks,
        startDate: body.startDate,
        endDate: sprintEndDate(body.startDate, body.durationWeeks),
      })
      .returning()

    await recordActivity({
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
    const id = req.params.id as string
    const body = req.body as {
      name?: string
      durationWeeks?: 1 | 2
      startDate?: Date
    }

    const [existing] = await db
      .select()
      .from(sprints)
      .where(eq(sprints.id, id))
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
      .where(eq(sprints.id, id))
      .returning()

    await recordActivity({
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
    const id = req.params.id as string

    const [existing] = await db
      .select()
      .from(sprints)
      .where(eq(sprints.id, id))
      .limit(1)

    if (!existing) {
      throw new NotFoundError("Sprint")
    }

    // Tickets survive the sprint; the foreign key nulls their sprintId so they
    // fall back into the backlog rather than disappearing.
    await db.delete(sprints).where(eq(sprints.id, id))

    await recordActivity({
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

tasksRouter.get("/tickets", async (_req, res) => {
  const rows = await db.select().from(tickets).orderBy(desc(tickets.createdAt))
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

    const row = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(tickets)
        .values({
          id: newId(),
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
        ticketId: created.id,
        type: "created",
        actorId: user.id,
      })

      return created
    })

    await recordActivity({
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
      .where(eq(tickets.id, req.params.id as string))
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
    const id = req.params.id as string
    const body = req.body as TicketUpdate

    const [existing] = await db
      .select()
      .from(tickets)
      .where(eq(tickets.id, id))
      .limit(1)

    if (!existing) {
      throw new NotFoundError("Ticket")
    }

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
        .where(eq(tickets.id, id))
        .returning()

      if (!updated) {
        throw new NotFoundError("Ticket")
      }

      await tx.insert(ticketHistory).values(
        changes.map((field) => ({
          id: newId(),
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
            .where(eq(userTable.id, row.assigneeId))
            .limit(1)
            .then((rows) => rows[0]?.name ?? null)
        : null

      void fireDiscordTrigger("ticket_status_change", {
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
    const id = req.params.id as string

    const [existing] = await db
      .select()
      .from(tickets)
      .where(eq(tickets.id, id))
      .limit(1)

    if (!existing) {
      throw new NotFoundError("Ticket")
    }

    await db.delete(tickets).where(eq(tickets.id, id))

    await recordActivity({
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
      .where(eq(ticketHistory.ticketId, req.params.id as string))
      .orderBy(asc(ticketHistory.createdAt))

    res.json({ data: rows.map(serializeTicketHistory) })
  }
)

/** Whole-board history, used to hydrate the panel in one request. */
tasksRouter.get("/history", async (_req, res) => {
  const rows = await db
    .select()
    .from(ticketHistory)
    .orderBy(desc(ticketHistory.createdAt))
    .limit(500)

  res.json({ data: rows.map(serializeTicketHistory) })
})

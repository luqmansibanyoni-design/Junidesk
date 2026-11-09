import { randomUUID } from "node:crypto";
import {
  and,
  asc,
  count,
  desc,
  eq,
  ilike,
  inArray,
  isNull,
  or,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Router, type IRouter, type Request, type Response } from "express";
import {
  AddTicketAttachmentBody,
  AddTicketAttachmentParams,
  AddTicketAttachmentResponse,
  CreateTicketBody,
  CreateTicketMessageBody,
  CreateTicketMessageParams,
  CreateTicketMessageResponse,
  CreateTicketResponse,
  GetDashboardSummaryResponse,
  GetRecentActivityResponse,
  GetTicketParams,
  GetTicketResponse,
  ListTicketsQueryParams,
  ListTicketsResponse,
  UpdateTicketBody,
  UpdateTicketParams,
  UpdateTicketResponse,
} from "@workspace/api-zod";
import {
  categoriesTable,
  db,
  prioritiesTable,
  supportUsersTable,
  teamsTable,
  ticketActivityTable,
  ticketAttachmentsTable,
  ticketMessagesTable,
  ticketsTable,
} from "@workspace/db";
import {
  canManageTicket,
  canViewTicket,
  ensureReferenceData,
  getAppUser,
  recordActivity,
  sendForbidden,
  sendUnauthorized,
} from "../lib/junidesk";
import { ObjectStorageService } from "../lib/objectStorage";

const router: IRouter = Router();
const objectStorage = new ObjectStorageService();

function parseId(raw: string | string[] | undefined): number | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function escapedLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

function ticketAccessConditions(
  user: { id: string; role: string; teamIds: number[] },
) {
  if (user.role === "admin") return [];
  if (user.role === "requester") {
    return [eq(ticketsTable.requesterId, user.id)];
  }
  const teamCondition =
    user.teamIds.length > 0
      ? inArray(ticketsTable.teamId, user.teamIds)
      : undefined;
  return [
    teamCondition
      ? or(eq(ticketsTable.assigneeId, user.id), teamCondition)
      : eq(ticketsTable.assigneeId, user.id),
  ];
}

const requesterAlias = alias(supportUsersTable, "requester");
const assigneeAlias = alias(supportUsersTable, "assignee");

async function getTicketJoin(ticketId: number) {
  const [row] = await db
    .select({
      ticket: ticketsTable,
      requesterName: requesterAlias.name,
      requesterEmail: requesterAlias.email,
      assigneeName: assigneeAlias.name,
      categoryName: categoriesTable.name,
      teamName: teamsTable.name,
    })
    .from(ticketsTable)
    .innerJoin(
      requesterAlias,
      eq(ticketsTable.requesterId, requesterAlias.id),
    )
    .leftJoin(assigneeAlias, eq(ticketsTable.assigneeId, assigneeAlias.id))
    .leftJoin(categoriesTable, eq(ticketsTable.categoryId, categoriesTable.id))
    .leftJoin(teamsTable, eq(ticketsTable.teamId, teamsTable.id))
    .where(eq(ticketsTable.id, ticketId))
    .limit(1);
  return row;
}

function serializeTicket(
  row: NonNullable<Awaited<ReturnType<typeof getTicketJoin>>>,
  messageCount: number,
) {
  return {
    id: row.ticket.id,
    reference: row.ticket.reference,
    subject: row.ticket.subject,
    description: row.ticket.description,
    requesterId: row.ticket.requesterId,
    requesterName: row.requesterName,
    requesterEmail: row.requesterEmail,
    categoryId: row.ticket.categoryId,
    category: row.categoryName ?? "Uncategorized",
    priority: row.ticket.priority,
    status: row.ticket.status,
    assigneeId: row.ticket.assigneeId,
    assigneeName: row.assigneeName,
    teamId: row.ticket.teamId,
    teamName: row.teamName,
    createdAt: row.ticket.createdAt,
    updatedAt: row.ticket.updatedAt,
    lastActivityAt: row.ticket.lastActivityAt,
    messageCount,
  };
}

async function getVisibleMessageCount(
  ticketId: number,
  requesterOnly: boolean,
): Promise<number> {
  const conditions = [eq(ticketMessagesTable.ticketId, ticketId)];
  if (requesterOnly) {
    conditions.push(eq(ticketMessagesTable.visibility, "public"));
  }
  const [result] = await db
    .select({ value: count() })
    .from(ticketMessagesTable)
    .where(and(...conditions));
  return Number(result?.value ?? 0);
}

async function getTicketDetail(ticketId: number, requesterOnly: boolean) {
  const row = await getTicketJoin(ticketId);
  if (!row) return null;
  const messages = await db
    .select({
      id: ticketMessagesTable.id,
      ticketId: ticketMessagesTable.ticketId,
      authorId: ticketMessagesTable.authorId,
      authorName: supportUsersTable.name,
      body: ticketMessagesTable.body,
      visibility: ticketMessagesTable.visibility,
      createdAt: ticketMessagesTable.createdAt,
    })
    .from(ticketMessagesTable)
    .innerJoin(
      supportUsersTable,
      eq(ticketMessagesTable.authorId, supportUsersTable.id),
    )
    .where(
      requesterOnly
        ? and(
            eq(ticketMessagesTable.ticketId, ticketId),
            eq(ticketMessagesTable.visibility, "public"),
          )
        : eq(ticketMessagesTable.ticketId, ticketId),
    )
    .orderBy(asc(ticketMessagesTable.createdAt));
  const attachments = await db
    .select({
      id: ticketAttachmentsTable.id,
      ticketId: ticketAttachmentsTable.ticketId,
      name: ticketAttachmentsTable.name,
      contentType: ticketAttachmentsTable.contentType,
      size: ticketAttachmentsTable.size,
      objectPath: ticketAttachmentsTable.objectPath,
      createdAt: ticketAttachmentsTable.createdAt,
    })
    .from(ticketAttachmentsTable)
    .where(eq(ticketAttachmentsTable.ticketId, ticketId))
    .orderBy(asc(ticketAttachmentsTable.createdAt));

  return {
    ...serializeTicket(
      row,
      await getVisibleMessageCount(ticketId, requesterOnly),
    ),
    messages,
    attachments: attachments.map(({ objectPath, ...attachment }) => ({
      ...attachment,
      url: `/api/storage${objectPath}`,
    })),
  };
}

function canTransition(from: string, to: string): boolean {
  if (from === to) return true;
  const transitions: Record<string, string[]> = {
    New: ["Open", "Pending", "Resolved", "Closed"],
    Open: ["Pending", "Resolved", "Closed"],
    Pending: ["Open", "Resolved", "Closed"],
    Resolved: ["Open", "Closed"],
    Closed: ["Open"],
  };
  return transitions[from]?.includes(to) ?? false;
}

router.get("/tickets", async (req: Request, res: Response): Promise<void> => {
  const user = await getAppUser(req);
  if (!user) {
    sendUnauthorized(res);
    return;
  }
  const parsed = ListTicketsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  await ensureReferenceData();

  const filters = ticketAccessConditions(user);
  const query = parsed.data;
  if (query.status) filters.push(eq(ticketsTable.status, query.status));
  if (query.priority) filters.push(eq(ticketsTable.priority, query.priority));
  if (query.categoryId) {
    filters.push(eq(ticketsTable.categoryId, query.categoryId));
  }
  if (query.teamId && user.role !== "requester") {
    filters.push(eq(ticketsTable.teamId, query.teamId));
  }
  if (query.assigneeId && user.role !== "requester") {
    filters.push(eq(ticketsTable.assigneeId, query.assigneeId));
  }
  if (query.q?.trim()) {
    const term = `%${escapedLike(query.q.trim())}%`;
    filters.push(
      or(
        ilike(ticketsTable.reference, term),
        ilike(ticketsTable.subject, term),
        ilike(ticketsTable.description, term),
      )!,
    );
  }

  const sort = query.sort ?? "recent";
  const rows = await db
    .select({
      ticket: ticketsTable,
      requesterName: requesterAlias.name,
      requesterEmail: requesterAlias.email,
      assigneeName: assigneeAlias.name,
      categoryName: categoriesTable.name,
      teamName: teamsTable.name,
    })
    .from(ticketsTable)
    .innerJoin(
      requesterAlias,
      eq(ticketsTable.requesterId, requesterAlias.id),
    )
    .leftJoin(assigneeAlias, eq(ticketsTable.assigneeId, assigneeAlias.id))
    .leftJoin(categoriesTable, eq(ticketsTable.categoryId, categoriesTable.id))
    .leftJoin(teamsTable, eq(ticketsTable.teamId, teamsTable.id))
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(
      sort === "oldest"
        ? asc(ticketsTable.lastActivityAt)
        : desc(ticketsTable.lastActivityAt),
    )
    .limit(250);

  const visibleRows = user.role === "requester"
    ? rows.filter((row) => row.ticket.requesterId === user.id)
    : rows;
  const summaries = await Promise.all(
    visibleRows.map(async (row) => {
      const countConditions = [
        eq(ticketMessagesTable.ticketId, row.ticket.id),
      ];
      if (user.role === "requester") {
        countConditions.push(eq(ticketMessagesTable.visibility, "public"));
      }
      const [messageCountResult] = await db
        .select({ value: count() })
        .from(ticketMessagesTable)
        .where(and(...countConditions));
      return serializeTicket(row, Number(messageCountResult?.value ?? 0));
    }),
  );

  if (sort === "priority") {
    const priorityRows = await db
      .select({ name: prioritiesTable.name, rank: prioritiesTable.rank })
      .from(prioritiesTable);
    const rank = new Map(priorityRows.map((item) => [item.name, item.rank]));
    summaries.sort(
      (a, b) =>
        (rank.get(b.priority) ?? 0) - (rank.get(a.priority) ?? 0) ||
        new Date(b.lastActivityAt).getTime() -
          new Date(a.lastActivityAt).getTime(),
    );
  }

  res.json(ListTicketsResponse.parse(summaries));
});

router.post("/tickets", async (req: Request, res: Response): Promise<void> => {
  const user = await getAppUser(req);
  if (!user) {
    sendUnauthorized(res);
    return;
  }
  const parsed = CreateTicketBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  await ensureReferenceData();

  const [category] = await db
    .select()
    .from(categoriesTable)
    .where(
      and(
        eq(categoriesTable.id, parsed.data.categoryId),
        eq(categoriesTable.active, true),
      ),
    )
    .limit(1);
  if (!category) {
    res.status(400).json({ error: "Choose an active category." });
    return;
  }
  const [priority] = await db
    .select()
    .from(prioritiesTable)
    .where(
      and(
        eq(prioritiesTable.name, parsed.data.priority),
        eq(prioritiesTable.active, true),
      ),
    )
    .limit(1);
  if (!priority) {
    res.status(400).json({ error: "Choose an active priority." });
    return;
  }

  const reference = `JD-${randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`;
  const [ticket] = await db
    .insert(ticketsTable)
    .values({
      reference,
      subject: parsed.data.subject.trim(),
      description: parsed.data.description.trim(),
      requesterId: user.id,
      categoryId: category.id,
      priority: priority.name,
      teamId: category.teamId,
    })
    .returning();
  if (!ticket) {
    res.status(500).json({ error: "The ticket could not be created." });
    return;
  }
  await db.insert(ticketMessagesTable).values({
    ticketId: ticket.id,
    authorId: user.id,
    body: ticket.description,
    visibility: "public",
  });
  await recordActivity(ticket.id, user.id, "submitted this ticket");

  const detail = await getTicketDetail(ticket.id, false);
  res.status(201).json(CreateTicketResponse.parse(detail));
});

router.get(
  "/tickets/:ticketId",
  async (req: Request, res: Response): Promise<void> => {
    const user = await getAppUser(req);
    if (!user) {
      sendUnauthorized(res);
      return;
    }
    const params = GetTicketParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const row = await getTicketJoin(params.data.ticketId);
    if (!row) {
      res.status(404).json({ error: "Ticket not found." });
      return;
    }
    if (!(await canViewTicket(user, row.ticket))) {
      sendForbidden(res);
      return;
    }
    const detail = await getTicketDetail(
      row.ticket.id,
      user.role === "requester",
    );
    res.json(GetTicketResponse.parse(detail));
  },
);

router.patch(
  "/tickets/:ticketId",
  async (req: Request, res: Response): Promise<void> => {
    const user = await getAppUser(req);
    if (!user) {
      sendUnauthorized(res);
      return;
    }
    const params = UpdateTicketParams.safeParse(req.params);
    const parsed = UpdateTicketBody.safeParse(req.body);
    if (!params.success || !parsed.success) {
      res.status(400).json({
        error: params.success ? parsed.error.message : params.error.message,
      });
      return;
    }
    const row = await getTicketJoin(params.data.ticketId);
    if (!row) {
      res.status(404).json({ error: "Ticket not found." });
      return;
    }
    if (!(await canManageTicket(user, row.ticket))) {
      sendForbidden(res);
      return;
    }
    const input = parsed.data;
    if (input.status && !canTransition(row.ticket.status, input.status)) {
      res.status(400).json({
        error: `A ticket cannot move from ${row.ticket.status} to ${input.status}.`,
      });
      return;
    }
    if (input.priority) {
      const [priority] = await db
        .select({ name: prioritiesTable.name })
        .from(prioritiesTable)
        .where(
          and(
            eq(prioritiesTable.name, input.priority),
            eq(prioritiesTable.active, true),
          ),
        )
        .limit(1);
      if (!priority) {
        res.status(400).json({ error: "Choose an active priority." });
        return;
      }
    }
    if (input.categoryId) {
      const [category] = await db
        .select()
        .from(categoriesTable)
        .where(
          and(
            eq(categoriesTable.id, input.categoryId),
            eq(categoriesTable.active, true),
          ),
        )
        .limit(1);
      if (!category) {
        res.status(400).json({ error: "Choose an active category." });
        return;
      }
    }
    if (input.teamId !== undefined && input.teamId !== null) {
      const [team] = await db
        .select({ id: teamsTable.id })
        .from(teamsTable)
        .where(and(eq(teamsTable.id, input.teamId), eq(teamsTable.active, true)))
        .limit(1);
      if (!team) {
        res.status(400).json({ error: "Choose an active team." });
        return;
      }
    }
    if (input.assigneeId) {
      const [assignee] = await db
        .select({ id: supportUsersTable.id, role: supportUsersTable.role })
        .from(supportUsersTable)
        .where(
          and(
            eq(supportUsersTable.id, input.assigneeId),
            eq(supportUsersTable.role, "agent"),
            eq(supportUsersTable.active, true),
          ),
        )
        .limit(1);
      if (!assignee) {
        res.status(400).json({ error: "Choose an active agent." });
        return;
      }
    }

    const update: Partial<typeof ticketsTable.$inferInsert> = {
      updatedAt: new Date(),
      lastActivityAt: new Date(),
    };
    const actions: string[] = [];
    if (input.status !== undefined && input.status !== row.ticket.status) {
      update.status = input.status;
      actions.push(`changed status to ${input.status}`);
    }
    if (input.priority !== undefined && input.priority !== row.ticket.priority) {
      update.priority = input.priority;
      actions.push(`changed priority to ${input.priority}`);
    }
    if (
      input.categoryId !== undefined &&
      input.categoryId !== row.ticket.categoryId
    ) {
      update.categoryId = input.categoryId;
      const [category] = await db
        .select({ teamId: categoriesTable.teamId })
        .from(categoriesTable)
        .where(eq(categoriesTable.id, input.categoryId))
        .limit(1);
      update.teamId = category?.teamId ?? null;
      actions.push("changed the category");
    }
    if (input.teamId !== undefined && input.teamId !== row.ticket.teamId) {
      update.teamId = input.teamId;
      actions.push(
        input.teamId === null ? "removed the team assignment" : "changed the team",
      );
    }
    if (
      input.assigneeId !== undefined &&
      input.assigneeId !== row.ticket.assigneeId
    ) {
      update.assigneeId = input.assigneeId;
      actions.push(
        input.assigneeId === null ? "removed the assignee" : "assigned this ticket",
      );
    }
    if (input.status === "Resolved" || input.status === "Closed") {
      update.resolvedAt = row.ticket.resolvedAt ?? new Date();
    } else if (input.status && input.status !== row.ticket.status) {
      update.resolvedAt = null;
    }

    await db
      .update(ticketsTable)
      .set(update)
      .where(eq(ticketsTable.id, row.ticket.id));
    if (actions.length) {
      await recordActivity(row.ticket.id, user.id, actions.join(" and "));
    }

    const detail = await getTicketDetail(row.ticket.id, false);
    res.json(UpdateTicketResponse.parse(detail));
  },
);

router.post(
  "/tickets/:ticketId/messages",
  async (req: Request, res: Response): Promise<void> => {
    const user = await getAppUser(req);
    if (!user) {
      sendUnauthorized(res);
      return;
    }
    const params = CreateTicketMessageParams.safeParse(req.params);
    const parsed = CreateTicketMessageBody.safeParse(req.body);
    if (!params.success || !parsed.success) {
      res.status(400).json({
        error: params.success ? parsed.error.message : params.error.message,
      });
      return;
    }
    const row = await getTicketJoin(params.data.ticketId);
    if (!row) {
      res.status(404).json({ error: "Ticket not found." });
      return;
    }
    if (!(await canViewTicket(user, row.ticket))) {
      sendForbidden(res);
      return;
    }
    if (parsed.data.visibility === "internal" && user.role === "requester") {
      sendForbidden(res);
      return;
    }

    const [message] = await db
      .insert(ticketMessagesTable)
      .values({
        ticketId: row.ticket.id,
        authorId: user.id,
        body: parsed.data.body.trim(),
        visibility: parsed.data.visibility,
      })
      .returning();
    await db
      .update(ticketsTable)
      .set({ updatedAt: new Date(), lastActivityAt: new Date() })
      .where(eq(ticketsTable.id, row.ticket.id));
    await recordActivity(
      row.ticket.id,
      user.id,
      parsed.data.visibility === "internal" ? "added an internal note" : "replied",
    );
    const response = {
      ...message,
      authorName: user.name,
    };
    res.status(201).json(CreateTicketMessageResponse.parse(response));
  },
);

router.post(
  "/tickets/:ticketId/attachments",
  async (req: Request, res: Response): Promise<void> => {
    const user = await getAppUser(req);
    if (!user) {
      sendUnauthorized(res);
      return;
    }
    const params = AddTicketAttachmentParams.safeParse(req.params);
    const parsed = AddTicketAttachmentBody.safeParse(req.body);
    if (!params.success || !parsed.success) {
      res.status(400).json({
        error: params.success ? parsed.error.message : params.error.message,
      });
      return;
    }
    const row = await getTicketJoin(params.data.ticketId);
    if (!row) {
      res.status(404).json({ error: "Ticket not found." });
      return;
    }
    if (!(await canViewTicket(user, row.ticket))) {
      sendForbidden(res);
      return;
    }
    const objectPath = parsed.data.objectPath;
    if (!objectPath.startsWith("/objects/uploads/")) {
      res.status(400).json({ error: "Invalid uploaded file path." });
      return;
    }
    try {
      const objectFile = await objectStorage.getObjectEntityFile(objectPath);
      await objectStorage.trySetObjectEntityAclPolicy(objectPath, {
        owner: user.id,
        visibility: "private",
      });
      const [attachment] = await db
        .insert(ticketAttachmentsTable)
        .values({
          ticketId: row.ticket.id,
          objectPath,
          name: parsed.data.name,
          contentType: parsed.data.contentType,
          size: parsed.data.size,
          uploadedById: user.id,
        })
        .returning();
      await db
        .update(ticketsTable)
        .set({ updatedAt: new Date(), lastActivityAt: new Date() })
        .where(eq(ticketsTable.id, row.ticket.id));
      await recordActivity(row.ticket.id, user.id, "added an attachment");
      void objectFile;
      res
        .status(201)
        .json(
          AddTicketAttachmentResponse.parse({
            id: attachment.id,
            ticketId: attachment.ticketId,
            name: attachment.name,
            contentType: attachment.contentType,
            size: attachment.size,
            url: `/api/storage${attachment.objectPath}`,
            createdAt: attachment.createdAt,
          }),
        );
    } catch (error) {
      req.log.error({ err: error }, "Unable to save ticket attachment");
      res.status(400).json({ error: "Uploaded file could not be verified." });
    }
  },
);

router.get(
  "/dashboard/summary",
  async (req: Request, res: Response): Promise<void> => {
    const user = await getAppUser(req);
    if (!user) {
      sendUnauthorized(res);
      return;
    }
    const scope = ticketAccessConditions(user);
    const visibleTickets = await db
      .select({
        id: ticketsTable.id,
        status: ticketsTable.status,
        priority: ticketsTable.priority,
        assigneeId: ticketsTable.assigneeId,
        createdAt: ticketsTable.createdAt,
        resolvedAt: ticketsTable.resolvedAt,
      })
      .from(ticketsTable)
      .where(scope.length ? and(...scope) : undefined);
    const byStatus = new Map<string, number>();
    const byPriority = new Map<string, number>();
    for (const ticket of visibleTickets) {
      byStatus.set(ticket.status, (byStatus.get(ticket.status) ?? 0) + 1);
      byPriority.set(
        ticket.priority,
        (byPriority.get(ticket.priority) ?? 0) + 1,
      );
    }
    const [unassignedResult] = await db
      .select({ value: count() })
      .from(ticketsTable)
      .where(
        and(
          ...scope,
          isNull(ticketsTable.assigneeId),
          inArray(ticketsTable.status, ["New", "Open", "Pending"]),
        ),
      );
    const resolutionHours = visibleTickets
      .filter((ticket) => ticket.resolvedAt)
      .map(
        (ticket) =>
          (ticket.resolvedAt!.getTime() - ticket.createdAt.getTime()) /
          3_600_000,
      );
    const averageResolutionHours = resolutionHours.length
      ? resolutionHours.reduce((sum, hours) => sum + hours, 0) /
        resolutionHours.length
      : 0;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const dueToday = visibleTickets.filter(
      (ticket) =>
        ["New", "Open", "Pending"].includes(ticket.status) &&
        ticket.createdAt >= today,
    ).length;

    res.json(
      GetDashboardSummaryResponse.parse({
        total: visibleTickets.length,
        byStatus: Array.from(byStatus, ([label, value]) => ({
          label,
          count: value,
        })),
        byPriority: Array.from(byPriority, ([label, value]) => ({
          label,
          count: value,
        })),
        unassigned: Number(unassignedResult?.value ?? 0),
        dueToday,
        averageResolutionHours,
      }),
    );
  },
);

router.get(
  "/dashboard/activity",
  async (req: Request, res: Response): Promise<void> => {
    const user = await getAppUser(req);
    if (!user) {
      sendUnauthorized(res);
      return;
    }
    const scope = ticketAccessConditions(user);
    const rows = await db
      .select({
        id: ticketActivityTable.id,
        ticketId: ticketsTable.id,
        ticketReference: ticketsTable.reference,
        ticketSubject: ticketsTable.subject,
        actorName: supportUsersTable.name,
        action: ticketActivityTable.action,
        createdAt: ticketActivityTable.createdAt,
      })
      .from(ticketActivityTable)
      .innerJoin(ticketsTable, eq(ticketActivityTable.ticketId, ticketsTable.id))
      .innerJoin(
        supportUsersTable,
        eq(ticketActivityTable.actorId, supportUsersTable.id),
      )
      .where(scope.length ? and(...scope) : undefined)
      .orderBy(desc(ticketActivityTable.createdAt))
      .limit(15);
    res.json(GetRecentActivityResponse.parse(rows));
  },
);

export default router;

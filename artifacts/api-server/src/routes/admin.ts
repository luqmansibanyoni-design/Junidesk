import { and, asc, count, eq, inArray } from "drizzle-orm";
import { Router, type IRouter, type Request, type Response } from "express";
import {
  CreateCategoryBody,
  CreateCategoryResponse,
  CreatePriorityBody,
  CreatePriorityResponse,
  CreateTeamBody,
  CreateTeamResponse,
  ListCategoriesResponse,
  ListPrioritiesResponse,
  ListTeamsResponse,
  ListUsersResponse,
  UpdateCategoryBody,
  UpdateCategoryParams,
  UpdateCategoryResponse,
  UpdatePriorityBody,
  UpdatePriorityParams,
  UpdatePriorityResponse,
  UpdateTeamBody,
  UpdateTeamParams,
  UpdateTeamResponse,
  UpdateUserBody,
  UpdateUserParams,
  UpdateUserResponse,
} from "@workspace/api-zod";
import {
  categoriesTable,
  db,
  prioritiesTable,
  supportUsersTable,
  teamMembersTable,
  teamsTable,
} from "@workspace/db";
import {
  ensureReferenceData,
  getAppUser,
  requireAdmin,
  sendUnauthorized,
} from "../lib/junidesk";

const router: IRouter = Router();

async function serializeUser(user: typeof supportUsersTable.$inferSelect) {
  const rows = await db
    .select({ teamId: teamMembersTable.teamId })
    .from(teamMembersTable)
    .where(eq(teamMembersTable.userId, user.id));
  return {
    ...user,
    teamIds: rows.map((row) => row.teamId),
  };
}

async function syncTeamMembers(teamId: number, userIds: string[]) {
  const uniqueIds = [...new Set(userIds)];
  if (uniqueIds.length) {
    const eligible = await db
      .select({ id: supportUsersTable.id })
      .from(supportUsersTable)
      .where(
        and(
          inArray(supportUsersTable.id, uniqueIds),
          eq(supportUsersTable.role, "agent"),
          eq(supportUsersTable.active, true),
        ),
      );
    if (eligible.length !== uniqueIds.length) {
      return false;
    }
  }
  await db.transaction(async (tx) => {
    await tx
      .delete(teamMembersTable)
      .where(eq(teamMembersTable.teamId, teamId));
    if (uniqueIds.length) {
      await tx
        .insert(teamMembersTable)
        .values(uniqueIds.map((userId) => ({ teamId, userId })))
        .onConflictDoNothing();
    }
  });
  return true;
}

router.get("/users", async (req: Request, res: Response): Promise<void> => {
  const user = await getAppUser(req);
  if (!user) {
    sendUnauthorized(res);
    return;
  }
  if (!requireAdmin(user, res)) return;

  const users = await db
    .select()
    .from(supportUsersTable)
    .orderBy(asc(supportUsersTable.name));
  const results = await Promise.all(users.map(serializeUser));
  res.json(ListUsersResponse.parse(results));
});

router.patch(
  "/users/:userId",
  async (req: Request, res: Response): Promise<void> => {
    const actor = await getAppUser(req);
    if (!actor) {
      sendUnauthorized(res);
      return;
    }
    if (!requireAdmin(actor, res)) return;

    const params = UpdateUserParams.safeParse(req.params);
    const parsed = UpdateUserBody.safeParse(req.body);
    if (!params.success || !parsed.success) {
      res.status(400).json({
        error: params.success ? parsed.error.message : params.error.message,
      });
      return;
    }
    const [target] = await db
      .select()
      .from(supportUsersTable)
      .where(eq(supportUsersTable.id, params.data.userId))
      .limit(1);
    if (!target) {
      res.status(404).json({ error: "User not found." });
      return;
    }
    if (
      target.id === actor.id &&
      (parsed.data.role !== undefined && parsed.data.role !== "admin" ||
        parsed.data.active === false)
    ) {
      res.status(400).json({
        error: "You cannot remove your own administrator access.",
      });
      return;
    }
    const wouldRemoveAdmin =
      target.role === "admin" &&
      (parsed.data.role !== undefined && parsed.data.role !== "admin" ||
        parsed.data.active === false);
    if (wouldRemoveAdmin) {
      const [adminCount] = await db
        .select({ value: count() })
        .from(supportUsersTable)
        .where(
          and(
            eq(supportUsersTable.role, "admin"),
            eq(supportUsersTable.active, true),
          ),
        );
      if (Number(adminCount?.value ?? 0) <= 1) {
        res.status(400).json({
          error: "JuniDesk must keep at least one active administrator.",
        });
        return;
      }
    }
    if (parsed.data.teamIds !== undefined && parsed.data.teamIds.length) {
      const activeTeams = await db
        .select({ id: teamsTable.id })
        .from(teamsTable)
        .where(
          and(
            inArray(teamsTable.id, parsed.data.teamIds),
            eq(teamsTable.active, true),
          ),
        );
      if (activeTeams.length !== new Set(parsed.data.teamIds).size) {
        res.status(400).json({ error: "Choose active teams." });
        return;
      }
    }

    const update: Partial<typeof supportUsersTable.$inferInsert> = {};
    if (parsed.data.role !== undefined) update.role = parsed.data.role;
    if (parsed.data.active !== undefined) update.active = parsed.data.active;
    await db
      .update(supportUsersTable)
      .set(update)
      .where(eq(supportUsersTable.id, target.id));
    if (parsed.data.teamIds !== undefined) {
      await db.transaction(async (tx) => {
        await tx
          .delete(teamMembersTable)
          .where(eq(teamMembersTable.userId, target.id));
        if (parsed.data.teamIds.length) {
          await tx
            .insert(teamMembersTable)
            .values(
              parsed.data.teamIds.map((teamId) => ({
                teamId,
                userId: target.id,
              })),
            )
            .onConflictDoNothing();
        }
      });
    }
    const [updated] = await db
      .select()
      .from(supportUsersTable)
      .where(eq(supportUsersTable.id, target.id))
      .limit(1);
    res.json(UpdateUserResponse.parse(await serializeUser(updated)));
  },
);

router.get("/teams", async (req: Request, res: Response): Promise<void> => {
  const user = await getAppUser(req);
  if (!user) {
    sendUnauthorized(res);
    return;
  }
  await ensureReferenceData();
  const teams = await db.select().from(teamsTable).orderBy(asc(teamsTable.name));
  const result = await Promise.all(
    teams.map(async (team) => {
      const members = await db
        .select({ userId: teamMembersTable.userId })
        .from(teamMembersTable)
        .where(eq(teamMembersTable.teamId, team.id));
      return { ...team, agentIds: members.map((member) => member.userId) };
    }),
  );
  res.json(ListTeamsResponse.parse(result));
});

router.post(
  "/teams",
  async (req: Request, res: Response): Promise<void> => {
    const user = await getAppUser(req);
    if (!user) {
      sendUnauthorized(res);
      return;
    }
    if (!requireAdmin(user, res)) return;
    const parsed = CreateTeamBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const [team] = await db
      .insert(teamsTable)
      .values({
        name: parsed.data.name.trim(),
        description: parsed.data.description ?? null,
      })
      .onConflictDoNothing()
      .returning();
    if (!team) {
      res.status(400).json({ error: "A team with that name already exists." });
      return;
    }
    const synced = await syncTeamMembers(
      team.id,
      parsed.data.agentIds ?? [],
    );
    if (!synced) {
      res.status(400).json({ error: "Choose active agent accounts." });
      return;
    }
    res
      .status(201)
      .json(
        CreateTeamResponse.parse({
          ...team,
          agentIds: parsed.data.agentIds ?? [],
        }),
      );
  },
);

router.patch(
  "/teams/:teamId",
  async (req: Request, res: Response): Promise<void> => {
    const user = await getAppUser(req);
    if (!user) {
      sendUnauthorized(res);
      return;
    }
    if (!requireAdmin(user, res)) return;
    const params = UpdateTeamParams.safeParse(req.params);
    const parsed = UpdateTeamBody.safeParse(req.body);
    if (!params.success || !parsed.success) {
      res.status(400).json({
        error: params.success ? parsed.error.message : params.error.message,
      });
      return;
    }
    const [existing] = await db
      .select()
      .from(teamsTable)
      .where(eq(teamsTable.id, params.data.teamId))
      .limit(1);
    if (!existing) {
      res.status(404).json({ error: "Team not found." });
      return;
    }
    const update: Partial<typeof teamsTable.$inferInsert> = {};
    if (parsed.data.name !== undefined) update.name = parsed.data.name.trim();
    if (parsed.data.description !== undefined) {
      update.description = parsed.data.description;
    }
    if (parsed.data.active !== undefined) update.active = parsed.data.active;
    await db
      .update(teamsTable)
      .set(update)
      .where(eq(teamsTable.id, existing.id));
    if (parsed.data.agentIds !== undefined) {
      const synced = await syncTeamMembers(existing.id, parsed.data.agentIds);
      if (!synced) {
        res.status(400).json({ error: "Choose active agent accounts." });
        return;
      }
    }
    const [updated] = await db
      .select()
      .from(teamsTable)
      .where(eq(teamsTable.id, existing.id))
      .limit(1);
    const members = await db
      .select({ userId: teamMembersTable.userId })
      .from(teamMembersTable)
      .where(eq(teamMembersTable.teamId, existing.id));
    res.json(
      UpdateTeamResponse.parse({
        ...updated,
        agentIds: members.map((member) => member.userId),
      }),
    );
  },
);

router.get(
  "/categories",
  async (req: Request, res: Response): Promise<void> => {
    const user = await getAppUser(req);
    if (!user) {
      sendUnauthorized(res);
      return;
    }
    await ensureReferenceData();
    const rows = await db
      .select()
      .from(categoriesTable)
      .orderBy(asc(categoriesTable.name));
    res.json(ListCategoriesResponse.parse(rows));
  },
);

router.post(
  "/categories",
  async (req: Request, res: Response): Promise<void> => {
    const user = await getAppUser(req);
    if (!user) {
      sendUnauthorized(res);
      return;
    }
    if (!requireAdmin(user, res)) return;
    const parsed = CreateCategoryBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const [category] = await db
      .insert(categoriesTable)
      .values({
        name: parsed.data.name.trim(),
        teamId: parsed.data.teamId ?? null,
      })
      .onConflictDoNothing()
      .returning();
    if (!category) {
      res.status(400).json({ error: "A category with that name already exists." });
      return;
    }
    res.status(201).json(CreateCategoryResponse.parse(category));
  },
);

router.patch(
  "/categories/:categoryId",
  async (req: Request, res: Response): Promise<void> => {
    const user = await getAppUser(req);
    if (!user) {
      sendUnauthorized(res);
      return;
    }
    if (!requireAdmin(user, res)) return;
    const params = UpdateCategoryParams.safeParse(req.params);
    const parsed = UpdateCategoryBody.safeParse(req.body);
    if (!params.success || !parsed.success) {
      res.status(400).json({
        error: params.success ? parsed.error.message : params.error.message,
      });
      return;
    }
    const [existing] = await db
      .select()
      .from(categoriesTable)
      .where(eq(categoriesTable.id, params.data.categoryId))
      .limit(1);
    if (!existing) {
      res.status(404).json({ error: "Category not found." });
      return;
    }
    const update: Partial<typeof categoriesTable.$inferInsert> = {};
    if (parsed.data.name !== undefined) update.name = parsed.data.name.trim();
    if (parsed.data.teamId !== undefined) update.teamId = parsed.data.teamId;
    if (parsed.data.active !== undefined) update.active = parsed.data.active;
    await db
      .update(categoriesTable)
      .set(update)
      .where(eq(categoriesTable.id, existing.id));
    const [updated] = await db
      .select()
      .from(categoriesTable)
      .where(eq(categoriesTable.id, existing.id))
      .limit(1);
    res.json(UpdateCategoryResponse.parse(updated));
  },
);

router.get(
  "/priorities",
  async (req: Request, res: Response): Promise<void> => {
    const user = await getAppUser(req);
    if (!user) {
      sendUnauthorized(res);
      return;
    }
    await ensureReferenceData();
    const rows = await db
      .select()
      .from(prioritiesTable)
      .orderBy(asc(prioritiesTable.rank));
    res.json(ListPrioritiesResponse.parse(rows));
  },
);

router.post(
  "/priorities",
  async (req: Request, res: Response): Promise<void> => {
    const user = await getAppUser(req);
    if (!user) {
      sendUnauthorized(res);
      return;
    }
    if (!requireAdmin(user, res)) return;
    const parsed = CreatePriorityBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const [priority] = await db
      .insert(prioritiesTable)
      .values({ name: parsed.data.name.trim(), rank: parsed.data.rank })
      .onConflictDoNothing()
      .returning();
    if (!priority) {
      res.status(400).json({ error: "A priority with that name already exists." });
      return;
    }
    res.status(201).json(CreatePriorityResponse.parse(priority));
  },
);

router.patch(
  "/priorities/:priorityId",
  async (req: Request, res: Response): Promise<void> => {
    const user = await getAppUser(req);
    if (!user) {
      sendUnauthorized(res);
      return;
    }
    if (!requireAdmin(user, res)) return;
    const params = UpdatePriorityParams.safeParse(req.params);
    const parsed = UpdatePriorityBody.safeParse(req.body);
    if (!params.success || !parsed.success) {
      res.status(400).json({
        error: params.success ? parsed.error.message : params.error.message,
      });
      return;
    }
    const [existing] = await db
      .select()
      .from(prioritiesTable)
      .where(eq(prioritiesTable.id, params.data.priorityId))
      .limit(1);
    if (!existing) {
      res.status(404).json({ error: "Priority not found." });
      return;
    }
    const update: Partial<typeof prioritiesTable.$inferInsert> = {};
    if (parsed.data.name !== undefined) update.name = parsed.data.name.trim();
    if (parsed.data.rank !== undefined) update.rank = parsed.data.rank;
    if (parsed.data.active !== undefined) update.active = parsed.data.active;
    await db
      .update(prioritiesTable)
      .set(update)
      .where(eq(prioritiesTable.id, existing.id));
    const [updated] = await db
      .select()
      .from(prioritiesTable)
      .where(eq(prioritiesTable.id, existing.id))
      .limit(1);
    res.json(UpdatePriorityResponse.parse(updated));
  },
);

export default router;

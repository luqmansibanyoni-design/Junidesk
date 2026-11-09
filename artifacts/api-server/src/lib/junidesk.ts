import { clerkClient, getAuth } from "@clerk/express";
import { eq } from "drizzle-orm";
import type { Request, Response } from "express";
import {
  db,
  categoriesTable,
  prioritiesTable,
  supportUsersTable,
  teamMembersTable,
  teamsTable,
  ticketActivityTable,
  type SupportUser,
} from "@workspace/db";

export type AppUser = SupportUser & { teamIds: number[] };

export async function getAppUser(req: Request): Promise<AppUser | null> {
  const userId = getAuth(req).userId;
  if (!userId) return null;

  let [record] = await db
    .select()
    .from(supportUsersTable)
    .where(eq(supportUsersTable.id, userId))
    .limit(1);

  if (!record || !record.email) {
    const identity = await clerkClient.users.getUser(userId);
    const email =
      identity.primaryEmailAddress?.emailAddress ??
      identity.emailAddresses[0]?.emailAddress ??
      "";
    const name =
      [identity.firstName, identity.lastName].filter(Boolean).join(" ") ||
      identity.username ||
      email ||
      "JuniDesk user";
    const configuredAdminEmail = process.env.JUNIDESK_ADMIN_EMAIL
      ?.trim()
      .toLowerCase();
    const role =
      configuredAdminEmail && email.toLowerCase() === configuredAdminEmail
        ? "admin"
        : "requester";

    await db
      .insert(supportUsersTable)
      .values({ id: userId, email, name, role })
      .onConflictDoUpdate({
        target: supportUsersTable.id,
        set: { email, name },
      });

    [record] = await db
      .select()
      .from(supportUsersTable)
      .where(eq(supportUsersTable.id, userId))
      .limit(1);
  }

  if (!record || !record.active) return null;

  const memberships = await db
    .select({ teamId: teamMembersTable.teamId })
    .from(teamMembersTable)
    .where(eq(teamMembersTable.userId, userId));

  return { ...record, teamIds: memberships.map(({ teamId }) => teamId) };
}

export function sendUnauthorized(res: Response): void {
  res.status(401).json({ error: "Sign in to continue." });
}

export function sendForbidden(res: Response): void {
  res.status(403).json({ error: "You do not have permission to do that." });
}

export function requireAdmin(user: AppUser, res: Response): boolean {
  if (user.role === "admin") return true;
  sendForbidden(res);
  return false;
}

export async function ensureReferenceData(): Promise<void> {
  await db
    .insert(teamsTable)
    .values({
      name: "Service Desk",
      description: "General support requests",
    })
    .onConflictDoNothing();

  const [team] = await db
    .select({ id: teamsTable.id })
    .from(teamsTable)
    .where(eq(teamsTable.name, "Service Desk"))
    .limit(1);
  if (!team) return;

  await db
    .insert(categoriesTable)
    .values([
      { name: "General Support", teamId: team.id },
      { name: "Accounts & Access", teamId: team.id },
      { name: "Hardware", teamId: team.id },
      { name: "Network", teamId: team.id },
      { name: "Software", teamId: team.id },
    ])
    .onConflictDoNothing();

  await db
    .insert(prioritiesTable)
    .values([
      { name: "Low", rank: 1 },
      { name: "Normal", rank: 2 },
      { name: "High", rank: 3 },
      { name: "Urgent", rank: 4 },
    ])
    .onConflictDoNothing();
}

export async function canViewTicket(
  user: AppUser,
  ticket: { requesterId: string; assigneeId: string | null; teamId: number | null },
): Promise<boolean> {
  if (user.role === "admin" || ticket.requesterId === user.id) return true;
  if (user.role !== "agent") return false;
  if (ticket.assigneeId === user.id) return true;
  return ticket.teamId !== null && user.teamIds.includes(ticket.teamId);
}

export async function canManageTicket(
  user: AppUser,
  ticket: { requesterId: string; assigneeId: string | null; teamId: number | null },
): Promise<boolean> {
  if (user.role === "admin") return true;
  if (user.role !== "agent") return false;
  return canViewTicket(user, ticket);
}

export async function recordActivity(
  ticketId: number,
  actorId: string,
  action: string,
): Promise<void> {
  await db.insert(ticketActivityTable).values({ ticketId, actorId, action });
}


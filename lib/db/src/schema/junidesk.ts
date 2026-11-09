import {
  boolean,
  integer,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const supportUsersTable = pgTable("junidesk_users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().default(""),
  name: text("name").notNull().default("JuniDesk user"),
  role: text("role").notNull().default("requester"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const teamsTable = pgTable("junidesk_teams", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
  description: text("description"),
  active: boolean("active").notNull().default(true),
});

export const teamMembersTable = pgTable(
  "junidesk_team_members",
  {
    teamId: integer("team_id")
      .notNull()
      .references(() => teamsTable.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => supportUsersTable.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.teamId, table.userId] })],
);

export const categoriesTable = pgTable("junidesk_categories", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
  teamId: integer("team_id").references(() => teamsTable.id, {
    onDelete: "set null",
  }),
  active: boolean("active").notNull().default(true),
});

export const prioritiesTable = pgTable("junidesk_priorities", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
  rank: integer("rank").notNull(),
  active: boolean("active").notNull().default(true),
});

export const ticketsTable = pgTable(
  "junidesk_tickets",
  {
    id: serial("id").primaryKey(),
    reference: text("reference").notNull(),
    subject: text("subject").notNull(),
    description: text("description").notNull(),
    requesterId: text("requester_id")
      .notNull()
      .references(() => supportUsersTable.id),
    categoryId: integer("category_id")
      .notNull()
      .references(() => categoriesTable.id),
    priority: text("priority").notNull().default("Normal"),
    status: text("status").notNull().default("New"),
    assigneeId: text("assignee_id").references(() => supportUsersTable.id, {
      onDelete: "set null",
    }),
    teamId: integer("team_id").references(() => teamsTable.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (table) => [uniqueIndex("junidesk_tickets_reference_unique").on(table.reference)],
);

export const ticketMessagesTable = pgTable("junidesk_ticket_messages", {
  id: serial("id").primaryKey(),
  ticketId: integer("ticket_id")
    .notNull()
    .references(() => ticketsTable.id, { onDelete: "cascade" }),
  authorId: text("author_id")
    .notNull()
    .references(() => supportUsersTable.id),
  body: text("body").notNull(),
  visibility: text("visibility").notNull().default("public"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const ticketAttachmentsTable = pgTable(
  "junidesk_ticket_attachments",
  {
    id: serial("id").primaryKey(),
    ticketId: integer("ticket_id")
      .notNull()
      .references(() => ticketsTable.id, { onDelete: "cascade" }),
    objectPath: text("object_path").notNull().unique(),
    name: text("name").notNull(),
    contentType: text("content_type").notNull(),
    size: integer("size").notNull(),
    uploadedById: text("uploaded_by_id")
      .notNull()
      .references(() => supportUsersTable.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
);

export const ticketActivityTable = pgTable("junidesk_ticket_activity", {
  id: serial("id").primaryKey(),
  ticketId: integer("ticket_id")
    .notNull()
    .references(() => ticketsTable.id, { onDelete: "cascade" }),
  actorId: text("actor_id")
    .notNull()
    .references(() => supportUsersTable.id),
  action: text("action").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertSupportUserSchema = createInsertSchema(supportUsersTable).omit({
  createdAt: true,
});
export const insertTeamSchema = createInsertSchema(teamsTable).omit({ id: true });
export const insertTeamMemberSchema = createInsertSchema(teamMembersTable);
export const insertCategorySchema = createInsertSchema(categoriesTable).omit({
  id: true,
});
export const insertPrioritySchema = createInsertSchema(prioritiesTable).omit({
  id: true,
});
export const insertTicketSchema = createInsertSchema(ticketsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const insertTicketMessageSchema = createInsertSchema(
  ticketMessagesTable,
).omit({ id: true, createdAt: true });
export const insertTicketAttachmentSchema = createInsertSchema(
  ticketAttachmentsTable,
).omit({ id: true, createdAt: true });
export const insertTicketActivitySchema = createInsertSchema(
  ticketActivityTable,
).omit({ id: true, createdAt: true });

export type SupportUser = typeof supportUsersTable.$inferSelect;
export type Team = typeof teamsTable.$inferSelect;
export type TeamMember = typeof teamMembersTable.$inferSelect;
export type Category = typeof categoriesTable.$inferSelect;
export type Priority = typeof prioritiesTable.$inferSelect;
export type Ticket = typeof ticketsTable.$inferSelect;
export type TicketMessage = typeof ticketMessagesTable.$inferSelect;
export type TicketAttachment = typeof ticketAttachmentsTable.$inferSelect;
export type TicketActivity = typeof ticketActivityTable.$inferSelect;

export const supportRoleSchema = z.enum(["requester", "agent", "admin"]);
export const ticketStatusSchema = z.enum([
  "New",
  "Open",
  "Pending",
  "Resolved",
  "Closed",
]);
export const messageVisibilitySchema = z.enum(["public", "internal"]);

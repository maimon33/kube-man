import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull(),
  displayName: text("display_name"),
  role: text("role", { enum: ["admin", "operator", "viewer"] }).notNull().default("viewer"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
}, (table) => [uniqueIndex("idx_users_email").on(table.email)]);

export const clusters = sqliteTable("clusters", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull().references(() => users.id),
  name: text("name").notNull(),
  endpoint: text("endpoint").notNull(),
  credentialRef: text("credential_ref").notNull(),
  provider: text("provider").notNull().default("kubernetes"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
}, (table) => [uniqueIndex("idx_clusters_owner_name").on(table.ownerId, table.name)]);

export const savedViews = sqliteTable("saved_views", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull().references(() => users.id),
  clusterId: text("cluster_id").references(() => clusters.id),
  name: text("name").notNull(),
  definition: text("definition", { mode: "json" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

export const terminalProfiles = sqliteTable("terminal_profiles", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull().references(() => users.id),
  name: text("name").notNull(),
  shell: text("shell").notNull().default("bash"),
  workingNamespace: text("working_namespace"),
  environment: text("environment", { mode: "json" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

export const auditEvents = sqliteTable("audit_events", {
  id: text("id").primaryKey(),
  actorId: text("actor_id").references(() => users.id),
  clusterId: text("cluster_id").references(() => clusters.id),
  action: text("action").notNull(),
  resource: text("resource"),
  metadata: text("metadata", { mode: "json" }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

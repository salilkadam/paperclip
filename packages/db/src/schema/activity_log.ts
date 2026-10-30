import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

export const activityLog = pgTable(
  "activity_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    actorType: text("actor_type").notNull().default("system"),
    actorId: text("actor_id").notNull(),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    agentId: uuid("agent_id").references(() => agents.id),
    runId: uuid("run_id").references(() => heartbeatRuns.id),
    responsibleUserId: text("responsible_user_id"),
    details: jsonb("details").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyCreatedIdx: index("activity_log_company_created_idx").on(table.companyId, table.createdAt),
    companyAgentCreatedIdx: index("activity_log_company_agent_created_idx").on(
      table.companyId,
      table.agentId,
      table.createdAt,
    ),
    companyResponsibleUserCreatedIdx: index("activity_log_company_responsible_user_created_idx").on(
      table.companyId,
      table.responsibleUserId,
      table.createdAt,
    ),
    runIdIdx: index("activity_log_run_id_idx").on(table.runId),
    entityIdx: index("activity_log_entity_type_id_idx").on(table.entityType, table.entityId),
    // Issue-list sort keys ask "newest activity row for this issue" as an
    // ordered `ORDER BY created_at DESC LIMIT 1` probe per visible issue
    // (see `issueLatestLogAtExpr` in the server). The generic
    // (entity_type, entity_id) index cannot answer that without reading every
    // row of the issue, so the probe degrades linearly with how much activity
    // the issue has accumulated. This partial index lets the probe seek
    // (company, entity) and stop at the first entry scanning newest-first.
    entityIssueCreatedDescIdx: index("activity_log_entity_issue_created_idx")
      .on(table.companyId, table.entityId, table.createdAt.desc())
      .where(sql`${table.entityType} = 'issue'`),
  }),
);

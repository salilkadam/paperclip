import { pgTable, uuid, text, timestamp, integer, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companySecrets } from "./company_secrets.js";
import { companySecretProviderConfigs } from "./company_secret_provider_configs.js";

export const companySecretVersions = pgTable(
  "company_secret_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    secretId: uuid("secret_id").notNull().references(() => companySecrets.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    material: jsonb("material").$type<Record<string, unknown>>().notNull(),
    valueSha256: text("value_sha256").notNull(),
    providerVersionRef: text("provider_version_ref"),
    /**
     * The provider (and provider vault) this version's material was written to.
     * Resolution uses these, not the parent's current provider, so a pinned old
     * version keeps resolving after the secret moves to another provider.
     * Null only on rows written before the column existed (backfilled).
     */
    provider: text("provider"),
    providerConfigId: uuid("provider_config_id").references(() => companySecretProviderConfigs.id, { onDelete: "set null" }),
    status: text("status").notNull().default("current"),
    fingerprintSha256: text("fingerprint_sha256").notNull(),
    rotationJobId: text("rotation_job_id"),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => ({
    secretIdx: index("company_secret_versions_secret_idx").on(table.secretId, table.createdAt),
    valueHashIdx: index("company_secret_versions_value_sha256_idx").on(table.valueSha256),
    fingerprintIdx: index("company_secret_versions_fingerprint_idx").on(table.fingerprintSha256),
    secretVersionUq: uniqueIndex("company_secret_versions_secret_version_uq").on(table.secretId, table.version),
  }),
);

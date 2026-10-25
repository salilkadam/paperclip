ALTER TABLE "company_secret_provider_configs" ADD COLUMN "is_company_default" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "company_secret_versions" ADD COLUMN "provider" text;--> statement-breakpoint
ALTER TABLE "company_secret_versions" ADD COLUMN "provider_config_id" uuid;--> statement-breakpoint
ALTER TABLE "company_secret_versions" ADD CONSTRAINT "company_secret_versions_provider_config_id_company_secret_provider_configs_id_fk" FOREIGN KEY ("provider_config_id") REFERENCES "public"."company_secret_provider_configs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "company_secret_provider_configs_company_default_uq" ON "company_secret_provider_configs" USING btree ("company_id") WHERE "company_secret_provider_configs"."is_company_default" = true;--> statement-breakpoint
-- Backfill: every existing version was written through its parent's provider and
-- provider vault (company_secrets.provider is immutable before this change).
UPDATE "company_secret_versions" AS v
SET "provider" = s."provider", "provider_config_id" = s."provider_config_id"
FROM "company_secrets" AS s
WHERE v."secret_id" = s."id" AND v."provider" IS NULL;
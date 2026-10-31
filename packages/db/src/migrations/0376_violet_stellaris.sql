CREATE TABLE "chat_board_trust_notices" (
	"company_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"principal_id" uuid NOT NULL,
	"last_notice_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_conversations" ADD COLUMN "board_trusted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_endpoint_resources" ADD COLUMN "board_trusted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_board_trust_notices" ADD CONSTRAINT "chat_board_trust_notices_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_board_trust_notices" ADD CONSTRAINT "chat_board_trust_notices_company_endpoint_fk" FOREIGN KEY ("company_id","endpoint_id") REFERENCES "public"."chat_endpoints"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_board_trust_notices" ADD CONSTRAINT "chat_board_trust_notices_company_principal_fk" FOREIGN KEY ("company_id","principal_id") REFERENCES "public"."chat_external_principals"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_board_trust_notices_endpoint_principal_uq" ON "chat_board_trust_notices" USING btree ("endpoint_id","principal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_endpoint_resources_board_trusted_uq" ON "chat_endpoint_resources" USING btree ("company_id","provider_resource_id") WHERE "chat_endpoint_resources"."board_trusted";
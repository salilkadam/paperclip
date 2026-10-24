import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  companies,
  costEvents,
  createDb,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("agent service remove", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-remove-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(costEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgentWithRun() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Remove Co",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    await db.insert(agents).values({ id: agentId, companyId, name: "Probe", role: "general", adapterType: "opencode_local", status: "terminated", lifecycleState: "terminated" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "on_demand", status: "succeeded" });
    return { companyId, agentId, runId };
  }

  it("deletes an agent whose runs recorded no spend", async () => {
    const { agentId } = await seedAgentWithRun();
    const removed = await agentService(db).remove(agentId);
    expect(removed?.id).toBe(agentId);
    expect(await db.select().from(agents).where(eq(agents.id, agentId))).toHaveLength(0);
  });

  it("refuses with a 409 and keeps spend history when the agent has recorded spend", async () => {
    const { companyId, agentId, runId } = await seedAgentWithRun();
    await db.insert(costEvents).values({
      companyId, agentId, heartbeatRunId: runId, provider: "gpuai", model: "qwen", costCents: 3, occurredAt: new Date(),
    });

    await expect(agentService(db).remove(agentId)).rejects.toMatchObject({
      status: 409,
      details: { code: "agent_has_spend_history" },
    });
    expect(await db.select().from(agents).where(eq(agents.id, agentId))).toHaveLength(1);
    expect(await db.select().from(costEvents).where(eq(costEvents.agentId, agentId))).toHaveLength(1);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId))).toHaveLength(1);
  });
});

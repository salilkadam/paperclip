import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping heartbeat-runs filter route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

type Db = ReturnType<typeof createDb>;

/**
 * Seed a company with one agent and one heartbeat run for it. The reported
 * production failure was a truncated agent id (`185455ec`) in the `agentId`
 * query filter reaching the UUID column and surfacing as a 500; these tests
 * pin the route-level 400 contract instead.
 */
async function seedFixture(db: Db) {
  const nonce = randomUUID().slice(0, 8);
  const [company] = await db
    .insert(companies)
    .values({
      name: `Heartbeat Filter Co ${nonce}`,
      issuePrefix: `HF${nonce.slice(0, 4).toUpperCase()}`,
      defaultResponsibleUserId: "board-user",
    })
    .returning();
  const [agent] = await db
    .insert(agents)
    .values({
      companyId: company!.id,
      name: "Run Runner",
      role: "general",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
    })
    .returning();
  const [run] = await db
    .insert(heartbeatRuns)
    .values({
      companyId: company!.id,
      agentId: agent!.id,
      status: "running",
      contextSnapshot: {},
    })
    .returning();
  return { company: company!, agent: agent!, run: run! };
}

function boardActor(companyId: string): Express.Request["actor"] {
  return {
    type: "board",
    userId: "board-user",
    companyIds: [companyId],
    isInstanceAdmin: true,
    source: "local_implicit",
  };
}

function createApp(db: Db, actor: Express.Request["actor"]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", agentRoutes(db));
  app.use(errorHandler);
  return app;
}

describeEmbeddedPostgres("heartbeat-runs agentId filter", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-runs-filter-");
    db = createDb(tempDb.connectionString);
    // Embedded Postgres cold-starts slowly on a loaded machine.
  }, 60_000);

  afterEach(async () => {
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("returns 400 for a malformed agentId filter instead of a database cast error", async () => {
    const { company } = await seedFixture(db);
    const app = createApp(db, boardActor(company.id));

    // The exact value from the reported production 500: a truncated uuid.
    const truncated = await request(app).get(
      `/api/companies/${company.id}/heartbeat-runs?agentId=185455ec`,
    );
    expect(truncated.status, JSON.stringify(truncated.body)).toBe(400);

    // isUuidLike trims, PostgreSQL does not — padded input must also be 400.
    const padded = await request(app).get(
      `/api/companies/${company.id}/heartbeat-runs?agentId=%20${randomUUID()}`,
    );
    expect(padded.status, JSON.stringify(padded.body)).toBe(400);
  });

  it("filters by a uuid agentId and treats an empty filter as all agents", async () => {
    const { company, agent, run } = await seedFixture(db);
    const app = createApp(db, boardActor(company.id));

    const filtered = await request(app).get(
      `/api/companies/${company.id}/heartbeat-runs?agentId=${agent.id}`,
    );
    expect(filtered.status, JSON.stringify(filtered.body)).toBe(200);
    expect(filtered.body.map((row: { id: string }) => row.id)).toEqual([run.id]);

    const missing = await request(app).get(
      `/api/companies/${company.id}/heartbeat-runs?agentId=${randomUUID()}`,
    );
    expect(missing.status).toBe(200);
    expect(missing.body).toEqual([]);

    const empty = await request(app).get(
      `/api/companies/${company.id}/heartbeat-runs?agentId=`,
    );
    expect(empty.status).toBe(200);
    expect(empty.body.map((row: { id: string }) => row.id)).toEqual([run.id]);
  });
});

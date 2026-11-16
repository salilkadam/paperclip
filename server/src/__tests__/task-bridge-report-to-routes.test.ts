import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import request from "supertest";
import express from "express";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  activityLog,
  agentApiKeys,
  agents,
  authUsers,
  companyMemberships,
  heartbeatRuns,
  issues,
  projects,
} from "@paperclipai/db";
import {
  INBOX_MINE_ISSUE_STATUS_FILTER,
  normalizeAgentApiKeyScope,
  taskBridgeAgentKeyScopeSchema,
  type TaskBridgeAgentKeyScope,
} from "@paperclipai/shared";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";
import { issueRoutes } from "../routes/issues.js";
import { agentService, TASK_BRIDGE_REPORT_TO_MINTING_ENV } from "../services/agents.js";
import { authorizationService } from "../services/authorization.js";
import {
  describeEmbeddedPostgres,
  resetCompanyIssueFixtures,
  routeApp,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
  type BoardActor,
} from "./helpers/route-test-harness.js";

// Mirrors the Inbox "Mine" tab query (ui/src/pages/Inbox.tsx listCompact call).
const INBOX_MINE_QUERY =
  `touchedByUserId=me&inboxArchivedByUserId=me&status=${INBOX_MINE_ISSUE_STATUS_FILTER}&includeRoutineExecutions=true&includeLiveDescendantSummary=true&view=compact`;

describeEmbeddedPostgres("task_bridge reportToUserId", () => {
  const ctx = useEmbeddedPostgres("paperclip-task-bridge-report-to-", {
    resetEach: async (db) => {
      await db.delete(activityLog);
      await db.delete(issues);
      await db.delete(heartbeatRuns);
      await db.delete(agentApiKeys);
      await db.delete(agents);
      await db.delete(projects);
      await resetCompanyIssueFixtures(db);
      await db.delete(authUsers);
    },
  });

  // Minting reportToUserId is off by default (rollback safety); this suite
  // exercises the enabled path and turns it off explicitly where it tests the gate.
  const previousMintFlag = process.env[TASK_BRIDGE_REPORT_TO_MINTING_ENV];
  beforeAll(() => {
    process.env[TASK_BRIDGE_REPORT_TO_MINTING_ENV] = "true";
  });
  afterAll(() => {
    if (previousMintFlag === undefined) delete process.env[TASK_BRIDGE_REPORT_TO_MINTING_ENV];
    else process.env[TASK_BRIDGE_REPORT_TO_MINTING_ENV] = previousMintFlag;
  });

  /** The real bearer-token path: actorMiddleware resolves the key from its plaintext token. */
  function bearerApp() {
    const app = express();
    app.use(express.json());
    app.use(actorMiddleware(ctx.db, { deploymentMode: "authenticated" }));
    app.use("/api", issueRoutes(ctx.db, {} as never));
    app.use(errorHandler);
    return app;
  }

  async function seed() {
    const db = ctx.db;
    const owner = await seedCompanyWithBoardAccess(db, "Bridge report-to");
    const { companyId } = owner;
    const otherMemberId = `user-${randomUUID()}`;
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: otherMemberId,
      status: "active",
      membershipRole: "member",
      updatedAt: new Date(),
    });
    // Real auth resolves the key's responsible user against auth users.
    await db.insert(authUsers).values([owner.userId, otherMemberId].map((id) => ({
      id, name: id, email: `${id}@example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date(),
    })));
    const [agent] = await db
      .insert(agents)
      .values({ companyId, name: `Bridge ${randomUUID()}`, role: "engineer", adapterType: "process" })
      .returning();
    const [projectA, projectB] = await db
      .insert(projects)
      .values([
        { companyId, name: `Bridge A ${randomUUID()}` },
        { companyId, name: `Bridge B ${randomUUID()}` },
      ])
      .returning();
    const [parentInA] = await db
      .insert(issues)
      .values({ companyId, title: "Bridge parent in A", status: "todo", projectId: projectA!.id })
      .returning();
    const [parentInB] = await db
      .insert(issues)
      .values({ companyId, title: "Bridge parent in B", status: "todo", projectId: projectB!.id })
      .returning();
    return { owner, companyId, otherMemberId, agent: agent!, projectA: projectA!, projectB: projectB!, parentInA: parentInA!, parentInB: parentInB! };
  }

  type Seeded = Awaited<ReturnType<typeof seed>>;

  async function mintBridge(s: Seeded, scope: Omit<TaskBridgeAgentKeyScope, "kind">) {
    const parsed = taskBridgeAgentKeyScopeSchema.parse({ kind: "task_bridge", ...scope });
    const key = await agentService(ctx.db).createApiKey(s.agent.id, "bridge", parsed, {
      responsibleUserId: s.owner.userId,
    });
    const actor = {
      type: "agent" as const,
      source: "agent_key" as const,
      agentId: s.agent.id,
      companyId: s.companyId,
      keyId: key.id,
      keyScope: key.scope,
      runId: null,
    };
    return { key, actor, app: routeApp(ctx.db, actor as unknown as BoardActor, issueRoutes) };
  }

  async function issuesTitled(companyId: string, title: string) {
    return ctx.db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.title, title)));
  }

  it("rejects a reportToUserId that is not an active member of the company at mint time", async () => {
    const s = await seed();
    await expect(
      agentService(ctx.db).createApiKey(s.agent.id, "bridge", {
        kind: "task_bridge",
        projectId: s.projectA.id,
        reportToUserId: `user-${randomUUID()}`,
      }),
    ).rejects.toMatchObject({ status: 422 });
    await ctx.db
      .update(companyMemberships)
      .set({ status: "suspended" })
      .where(eq(companyMemberships.principalId, s.otherMemberId));
    await expect(
      agentService(ctx.db).createApiKey(s.agent.id, "bridge", {
        kind: "task_bridge",
        projectId: s.projectA.id,
        reportToUserId: s.otherMemberId,
      }),
    ).rejects.toMatchObject({ status: 422 });
    // reportToUserId is meaningless without a project boundary, so it is refused.
    expect(
      taskBridgeAgentKeyScopeSchema.safeParse({
        kind: "task_bridge",
        parentIssueId: s.parentInA.id,
        reportToUserId: s.owner.userId,
      }).success,
    ).toBe(false);
  });

  it("creates in its own project, assigns the report-to user, records the key, and lands in the owner's Inbox Mine", async () => {
    const s = await seed();
    const { key, app } = await mintBridge(s, { projectId: s.projectA.id, reportToUserId: s.owner.userId });
    expect(key.scope).toMatchObject({ kind: "task_bridge", reportToUserId: s.owner.userId });

    const res = await request(app)
      .post(`/api/companies/${s.companyId}/issues`)
      .send({ title: "Bridge report to owner", projectId: s.projectA.id, assigneeUserId: s.owner.userId, status: "todo" });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({
      assigneeUserId: s.owner.userId,
      projectId: s.projectA.id,
      originKind: "task_bridge",
      originId: key.id,
      createdByAgentId: s.agent.id,
      createdByUserId: null,
    });

    const [created] = await ctx.db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.entityId, res.body.id), eq(activityLog.action, "issue.created")));
    expect(created).toMatchObject({ actorType: "agent", actorId: s.agent.id, agentId: s.agent.id });
    expect(created!.details).toMatchObject({ taskBridgeKeyId: key.id, assigneeUserId: s.owner.userId });

    const ownerApp = routeApp(ctx.db, s.owner.actor, issueRoutes);
    const mine = await request(ownerApp).get(`/api/companies/${s.companyId}/issues?${INBOX_MINE_QUERY}`);
    expect(mine.status, JSON.stringify(mine.body)).toBe(200);
    expect(mine.body.map((issue: { id: string }) => issue.id)).toContain(res.body.id);
  });

  it("creates a child of its own issue assigned to the report-to user and audits the key", async () => {
    const s = await seed();
    const { key, app } = await mintBridge(s, { projectId: s.projectA.id, reportToUserId: s.owner.userId });
    const parent = await request(app)
      .post(`/api/companies/${s.companyId}/issues`)
      .send({ title: "Bridge own parent", projectId: s.projectA.id, status: "todo" });
    expect(parent.status, JSON.stringify(parent.body)).toBe(201);
    const child = await request(app)
      .post(`/api/issues/${parent.body.id}/children`)
      .send({ title: "Bridge child to owner", assigneeUserId: s.owner.userId, status: "todo" });
    expect(child.status, JSON.stringify(child.body)).toBe(201);
    expect(child.body).toMatchObject({
      parentId: parent.body.id,
      projectId: s.projectA.id,
      assigneeUserId: s.owner.userId,
      originKind: "task_bridge",
      originId: key.id,
    });
    const [audit] = await ctx.db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.entityId, child.body.id), eq(activityLog.action, "issue.child_created")));
    expect(audit!.details).toMatchObject({ taskBridgeKeyId: key.id, assigneeUserId: s.owner.userId });
  });

  it("refuses report-to assignment through accepted-plan decomposition", async () => {
    const s = await seed();
    const { app } = await mintBridge(s, { projectId: s.projectA.id, reportToUserId: s.owner.userId });
    const parent = await request(app)
      .post(`/api/companies/${s.companyId}/issues`)
      .send({ title: "Bridge decomposition source", projectId: s.projectA.id, status: "todo" });
    expect(parent.status, JSON.stringify(parent.body)).toBe(201);
    const res = await request(app)
      .post(`/api/issues/${parent.body.id}/accepted-plan-decompositions`)
      .send({
        acceptedPlanRevisionId: randomUUID(),
        children: [{ title: "Bridge decomposed to owner", assigneeUserId: s.owner.userId, status: "todo" }],
      });
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toContain("only assign their report-to user when creating");
    expect(await issuesTitled(s.companyId, "Bridge decomposed to owner")).toHaveLength(0);
  });

  it("creates in its own project without an assignee (previously 404 via project:read)", async () => {
    const s = await seed();
    const { app } = await mintBridge(s, { projectId: s.projectA.id });
    const res = await request(app)
      .post(`/api/companies/${s.companyId}/issues`)
      .send({ title: "Bridge unassigned in own project", projectId: s.projectA.id, status: "todo" });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ projectId: s.projectA.id, assigneeUserId: null });
  });

  it("refuses any board user other than the report-to user, even an active member", async () => {
    const s = await seed();
    const { app } = await mintBridge(s, { projectId: s.projectA.id, reportToUserId: s.owner.userId });
    const res = await request(app)
      .post(`/api/companies/${s.companyId}/issues`)
      .send({ title: "Bridge to other member", projectId: s.projectA.id, assigneeUserId: s.otherMemberId, status: "todo" });
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(await issuesTitled(s.companyId, "Bridge to other member")).toHaveLength(0);
  });

  it("refuses every board user for a key without reportToUserId", async () => {
    const s = await seed();
    const { app } = await mintBridge(s, { projectId: s.projectA.id });
    for (const userId of [s.owner.userId, s.otherMemberId]) {
      const res = await request(app)
        .post(`/api/companies/${s.companyId}/issues`)
        .send({ title: `Bridge no report-to ${userId}`, projectId: s.projectA.id, assigneeUserId: userId, status: "todo" });
      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(await issuesTitled(s.companyId, `Bridge no report-to ${userId}`)).toHaveLength(0);
    }
  });

  it("refuses to create outside its project boundary, even through an in-boundary parent", async () => {
    const s = await seed();
    // A parent in project A that the bridge agent may read (it is the assignee),
    // so the parent-boundary match alone would let tasks:assign pass.
    const [readableParent] = await ctx.db
      .insert(issues)
      .values({ companyId: s.companyId, title: "Bridge readable parent", status: "todo", projectId: s.projectA.id, assigneeAgentId: s.agent.id })
      .returning();
    const { app } = await mintBridge(s, {
      projectIds: [s.projectA.id],
      parentIssueIds: [readableParent!.id],
      reportToUserId: s.owner.userId,
    });
    // Parent is inside the boundary but the target project is not: the parent
    // match must not smuggle the issue into project B.
    const viaParent = await request(app)
      .post(`/api/companies/${s.companyId}/issues`)
      .send({ title: "Bridge into B via parent", projectId: s.projectB.id, parentId: readableParent!.id, status: "todo" });
    expect(viaParent.status, JSON.stringify(viaParent.body)).toBe(404);
    expect(await issuesTitled(s.companyId, "Bridge into B via parent")).toHaveLength(0);

    const direct = await request(app)
      .post(`/api/companies/${s.companyId}/issues`)
      .send({ title: "Bridge into B", projectId: s.projectB.id, assigneeUserId: s.owner.userId, status: "todo" });
    expect(direct.status, JSON.stringify(direct.body)).toBe(404);
    expect(await issuesTitled(s.companyId, "Bridge into B")).toHaveLength(0);
  });

  it("refuses the report-to user when the issue only matches a parent boundary outside its projects", async () => {
    const s = await seed();
    const { app } = await mintBridge(s, {
      projectIds: [s.projectA.id],
      parentIssueIds: [s.parentInB.id],
      reportToUserId: s.owner.userId,
    });
    const res = await request(app)
      .post(`/api/issues/${s.parentInB.id}/children`)
      .send({ title: "Bridge child in B to owner", assigneeUserId: s.owner.userId, status: "todo" });
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(await issuesTitled(s.companyId, "Bridge child in B to owner")).toHaveLength(0);
  });

  it("refuses the report-to user on an existing issue the key did not create", async () => {
    const s = await seed();
    const { actor } = await mintBridge(s, { projectId: s.projectA.id, reportToUserId: s.owner.userId });
    const [foreign] = await ctx.db
      .insert(issues)
      .values({ companyId: s.companyId, title: "Not bridge created", status: "todo", projectId: s.projectA.id })
      .returning();
    const decision = await authorizationService(ctx.db).decide({
      actor,
      action: "tasks:assign",
      resource: {
        type: "issue",
        companyId: s.companyId,
        issueId: foreign!.id,
        projectId: s.projectA.id,
        assigneeUserId: s.owner.userId,
      },
    });
    expect(decision).toMatchObject({ allowed: false, reason: "deny_scope" });
  });

  it("still denies general project:read to a task_bridge key", async () => {
    const s = await seed();
    const { actor } = await mintBridge(s, { projectId: s.projectA.id, reportToUserId: s.owner.userId });
    const decision = await authorizationService(ctx.db).decide({
      actor,
      action: "project:read",
      resource: { type: "project", companyId: s.companyId, projectId: s.projectA.id },
    });
    expect(decision).toMatchObject({ allowed: false, reason: "deny_scope" });
  });
  it("refuses to mint reportToUserId while the minting flag is off", async () => {
    const s = await seed();
    process.env[TASK_BRIDGE_REPORT_TO_MINTING_ENV] = "false";
    try {
      await expect(
        agentService(ctx.db).createApiKey(s.agent.id, "bridge", {
          kind: "task_bridge",
          projectId: s.projectA.id,
          reportToUserId: s.owner.userId,
        }),
      ).rejects.toMatchObject({ status: 422 });
      // A key without the field is unaffected by the flag.
      const plain = await agentService(ctx.db).createApiKey(s.agent.id, "bridge", { kind: "task_bridge", projectId: s.projectA.id });
      expect(plain.scope).toMatchObject({ kind: "task_bridge", projectId: s.projectA.id });
    } finally {
      process.env[TASK_BRIDGE_REPORT_TO_MINTING_ENV] = "true";
    }
    expect(await ctx.db.select().from(agentApiKeys).where(eq(agentApiKeys.agentId, s.agent.id))).toHaveLength(1);
  });

  it("authenticates the plaintext token through the real auth middleware and keeps the stored scope intact", async () => {
    const s = await seed();
    const { key } = await mintBridge(s, { projectId: s.projectA.id, reportToUserId: s.owner.userId });
    const [row] = await ctx.db.select().from(agentApiKeys).where(eq(agentApiKeys.id, key.id));
    const reparsed = normalizeAgentApiKeyScope(row!.scopeConfig);
    expect(reparsed).toMatchObject({ kind: "task_bridge", projectId: s.projectA.id, reportToUserId: s.owner.userId });

    const res = await request(bearerApp())
      .post(`/api/companies/${s.companyId}/issues`)
      .set("Authorization", `Bearer ${key.token}`)
      .send({ title: "Bridge via bearer", projectId: s.projectA.id, assigneeUserId: s.owner.userId, status: "todo" });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({
      assigneeUserId: s.owner.userId,
      originKind: "task_bridge",
      originId: key.id,
      createdByAgentId: s.agent.id,
      createdByUserId: null,
    });
    // Still bounded through the real path: another member and another project are refused.
    const other = await request(bearerApp())
      .post(`/api/companies/${s.companyId}/issues`)
      .set("Authorization", `Bearer ${key.token}`)
      .send({ title: "Bridge via bearer to other", projectId: s.projectA.id, assigneeUserId: s.otherMemberId, status: "todo" });
    expect(other.status, JSON.stringify(other.body)).toBe(403);
    const foreignProject = await request(bearerApp())
      .post(`/api/companies/${s.companyId}/issues`)
      .set("Authorization", `Bearer ${key.token}`)
      .send({ title: "Bridge via bearer into B", projectId: s.projectB.id, status: "todo" });
    expect(foreignProject.status, JSON.stringify(foreignProject.body)).toBe(404);
    expect(await issuesTitled(s.companyId, "Bridge via bearer to other")).toHaveLength(0);
    expect(await issuesTitled(s.companyId, "Bridge via bearer into B")).toHaveLength(0);
  });

  it("refuses a key whose stored scope does not parse instead of treating it as a standard key", async () => {
    const s = await seed();
    const { key } = await mintBridge(s, { projectId: s.projectA.id, reportToUserId: s.owner.userId });
    // Simulates a scope written by a newer build: an extra field the strict schema rejects.
    await ctx.db
      .update(agentApiKeys)
      .set({ scopeConfig: { kind: "task_bridge", projectId: s.projectA.id, futureField: "x" } as never })
      .where(eq(agentApiKeys.id, key.id));

    const res = await request(bearerApp())
      .post(`/api/companies/${s.companyId}/issues`)
      .set("Authorization", `Bearer ${key.token}`)
      .send({ title: "Bridge with unparseable scope", projectId: s.projectB.id, status: "todo" });
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(JSON.stringify(res.body)).toContain("KEY_SCOPE_UNRECOGNISED");
    expect(await issuesTitled(s.companyId, "Bridge with unparseable scope")).toHaveLength(0);
    const list = await request(bearerApp())
      .get(`/api/companies/${s.companyId}/issues`)
      .set("Authorization", `Bearer ${key.token}`);
    expect(list.status, JSON.stringify(list.body)).toBe(403);
    const audits = await ctx.db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.entityId, key.id), eq(activityLog.action, "auth.agent_key_invalid_scope")));
    expect(audits.length).toBeGreaterThanOrEqual(1);

    // The board can still see it flagged and revoke it.
    const boardApp = routeApp(ctx.db, s.owner.actor, agentRoutes);
    const keys = await request(boardApp).get(`/api/agents/${s.agent.id}/keys`);
    expect(keys.status, JSON.stringify(keys.body)).toBe(200);
    const listed = keys.body.find((k: { id: string }) => k.id === key.id);
    expect(listed.scope).toEqual({ kind: "unrecognised" });
    const revoke = await request(boardApp).delete(`/api/agents/${s.agent.id}/keys/${key.id}`);
    expect(revoke.status, JSON.stringify(revoke.body)).toBe(200);

    // A legacy standard key (null scope) still authenticates.
    const standard = await agentService(ctx.db).createApiKey(s.agent.id, "standard", { kind: "standard" }, {
      responsibleUserId: s.owner.userId,
    });
    const [standardRow] = await ctx.db.select().from(agentApiKeys).where(eq(agentApiKeys.id, standard.id));
    expect(standardRow!.scopeConfig).toBeNull();
    const standardList = await request(bearerApp())
      .get(`/api/companies/${s.companyId}/issues`)
      .set("Authorization", `Bearer ${standard.token}`);
    expect(standardList.status, JSON.stringify(standardList.body)).toBe(200);
  });

  it("PATCH (real bearer + run): refuses reassigning a foreign issue to the report-to user, allows its own, refuses moving project", async () => {
    const s = await seed();
    const { key } = await mintBridge(s, { projectId: s.projectA.id, reportToUserId: s.owner.userId });
    const [run] = await ctx.db
      .insert(heartbeatRuns)
      .values({ companyId: s.companyId, agentId: s.agent.id, status: "running" })
      .returning();
    const app = bearerApp();
    const as = (req: request.Test) => req.set("Authorization", `Bearer ${key.token}`).set("X-Paperclip-Run-Id", run!.id);

    const [foreign] = await ctx.db
      .insert(issues)
      .values({ companyId: s.companyId, title: "Foreign in A", status: "todo", projectId: s.projectA.id, assigneeAgentId: s.agent.id })
      .returning();
    const foreignPatch = await as(request(app).patch(`/api/issues/${foreign!.id}`)).send({ assigneeUserId: s.owner.userId, assigneeAgentId: null });
    expect(foreignPatch.status, JSON.stringify(foreignPatch.body)).toBe(403);
    expect(foreignPatch.body.code).not.toBe("cross_issue_influence_run_context_required");
    const [foreignAfter] = await ctx.db.select().from(issues).where(eq(issues.id, foreign!.id));
    expect(foreignAfter!.assigneeUserId).toBeNull();

    const own = await as(request(app).post(`/api/companies/${s.companyId}/issues`))
      .send({ title: "Bridge own for patch", projectId: s.projectA.id, status: "todo" });
    expect(own.status, JSON.stringify(own.body)).toBe(201);
    const ownPatch = await as(request(app).patch(`/api/issues/${own.body.id}`)).send({ assigneeUserId: s.owner.userId });
    expect(ownPatch.status, JSON.stringify(ownPatch.body)).toBe(200);
    expect(ownPatch.body.assigneeUserId).toBe(s.owner.userId);

    const move = await as(request(app).patch(`/api/issues/${own.body.id}`)).send({ projectId: s.projectB.id });
    expect(move.status, JSON.stringify(move.body)).toBe(404);
    const [ownAfter] = await ctx.db.select().from(issues).where(eq(issues.id, own.body.id));
    expect(ownAfter!.projectId).toBe(s.projectA.id);
  });

  it("refuses minting through the HTTP route for a non-board actor", async () => {
    const s = await seed();
    const { actor } = await mintBridge(s, { projectId: s.projectA.id });
    const agentApp = routeApp(ctx.db, actor as unknown as BoardActor, agentRoutes);
    const res = await request(agentApp)
      .post(`/api/agents/${s.agent.id}/keys`)
      .send({ name: "self-minted", scope: { kind: "task_bridge", projectId: s.projectA.id, reportToUserId: s.owner.userId } });
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    const minted = await ctx.db.select().from(agentApiKeys).where(eq(agentApiKeys.name, "self-minted"));
    expect(minted).toHaveLength(0);
    // The board can mint the same scope through the route.
    const boardApp = routeApp(ctx.db, s.owner.actor, agentRoutes);
    const ok = await request(boardApp)
      .post(`/api/agents/${s.agent.id}/keys`)
      .send({ name: "board-minted", scope: { kind: "task_bridge", projectId: s.projectA.id, reportToUserId: s.owner.userId } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
  });

  it("refuses assignment once the report-to user is suspended after mint", async () => {
    const s = await seed();
    const { app } = await mintBridge(s, { projectId: s.projectA.id, reportToUserId: s.otherMemberId });
    await ctx.db
      .update(companyMemberships)
      .set({ status: "suspended" })
      .where(eq(companyMemberships.principalId, s.otherMemberId));
    const res = await request(app)
      .post(`/api/companies/${s.companyId}/issues`)
      .send({ title: "Bridge to suspended", projectId: s.projectA.id, assigneeUserId: s.otherMemberId, status: "todo" });
    // assertAssignableUser re-checks active membership on every use.
    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(res.body.error).toBe("Assignee user not found");
    expect(await issuesTitled(s.companyId, "Bridge to suspended")).toHaveLength(0);
  });
});

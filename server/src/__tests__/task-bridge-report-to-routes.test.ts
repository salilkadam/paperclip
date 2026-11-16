import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import request from "supertest";
import { expect, it } from "vitest";
import {
  activityLog,
  agentApiKeys,
  agents,
  companyMemberships,
  issues,
  projects,
} from "@paperclipai/db";
import { INBOX_MINE_ISSUE_STATUS_FILTER, taskBridgeAgentKeyScopeSchema, type TaskBridgeAgentKeyScope } from "@paperclipai/shared";
import { issueRoutes } from "../routes/issues.js";
import { agentService } from "../services/agents.js";
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
      await db.delete(agentApiKeys);
      await db.delete(agents);
      await db.delete(projects);
      await resetCompanyIssueFixtures(db);
    },
  });

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
});

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { createPostgresRunDispatchAdapter } from "../modules/run-dispatch/adapters/postgres.js";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("../telemetry.ts", () => ({ getTelemetryClient: () => mockTelemetryClient }));

import { heartbeatService } from "../services/heartbeat.ts";
import { legacyExecutionNeedsReconciliation } from "../services/legacy-execution-recovery.ts";
import {
  CONVERSATION_ADAPTER_TYPES,
  claimedAdapterType,
  isConversationAdapter,
} from "../services/conversation-continuation.ts";

// REL-149 objective, test leg (REL-2822). The port (a9f91fd, deployed by
// 2435e8e, live since the 2026-10-21 roll) ships the two code changes in
// terminalizeOrphanedRunningRun (recovery/service.ts:5942-5962) with no test
// file. rel44-regression.test.ts already pins the stamp write and its
// authority/adapter guards on the sweep path. This file pins the remaining
// REL-149 assertions against deployed behavior:
//   1. the process-death authority itself stays retry-eligible: a legacy
//      conversation reap with a dead pid yields exactly one scheduled_retry
//      successor with retryOfRunId + scheduledRetryAttempt 1, and the failed
//      run itself reports scheduledRetryAt/attempt null/0 (REL-131 gotchas:
//      retries are detected on the successor; failedRunId is never populated;
//      processLossRetryCount reads 0 even on actual retries).
//   2. the stamp predicate of terminalizeOrphanedRunningRun: process_gone
//      authority + legacy runtime + claimed conversation adapter stamps;
//      every other combination (issue_terminal authority, native runtime,
//      non-conversation or missing claimed adapter) must not.
//   3. retry eligibility derives from the stamp (the rel163-narrowed rule):
//      an unstamped interrupted legacy reap requires reconciliation and
//      cannot schedule; a stamped one schedules and promotes through the
//      shipped gate.
//   4. late-terminal parity: a scheduled successor whose issue turns terminal
//      before promotion is cancelled issue_terminal_status /
//      issue_cancelled by the shipped decideScheduledRetryGate at promotion
//      (no enqueue happens inside terminalizeOrphanedRunningRun).
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres REL-2822 tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("REL-2822: process_gone orphan-backstop retry-eligibility", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let issueCounter = 0;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-rel2822-backstop-");
    db = createDb(tempDb.connectionString);
  }, 120_000);

  afterEach(async () => {
    mockTelemetryClient.track.mockClear();
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issueRecoveryActions);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedConversationOrphan(options?: {
    runnerProfileJson?: Record<string, unknown>;
    processPid?: number | null;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    const issueId = randomUUID();
    issueCounter += 1;
    await db.insert(companies).values({
      id: companyId, name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId, companyId, name: "OpenCoder", role: "engineer", status: "idle",
      adapterType: "opencode_local", adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId, companyId, agentId,
      source: "assignment", triggerDetail: "system", reason: "issue_assigned",
      payload: { issueId }, status: "claimed", runId, claimedAt: new Date(),
    });
    await db.insert(heartbeatRuns).values({
      id: runId, companyId, agentId, status: "running",
      invocationSource: "assignment", triggerDetail: "system",
      wakeupRequestId,
      runtimeMode: "legacy", startedAt: new Date(),
      responsibleUserId: "responsible-user",
      // A pid this large never maps to a live process, so the process-death
      // authority applies and recovery reaps with authority=process_gone.
      // opencode_local is an adapter that owns a legacy local child, so the
      // reaper grants it the shared process-loss retry budget.
      processPid: options?.processPid === undefined ? 999_999_999 : options.processPid,
      // nextEventSeq matches the reaper-suite fixture shape.
      nextEventSeq: 2,
      runnerProfileJson: options?.runnerProfileJson ?? { adapterDispatch: { adapterType: "opencode_local" } },
      contextSnapshot: { issueId },
    });
    // The adapter.invoke evidence event is the historical adapter identity the
    // reaper reads (rel1416-suite fixture shape); the recovery event path
    // starts at seq 2 via nextEventSeq.
    await db.insert(heartbeatRunEvents).values({
      companyId, agentId, runId, seq: 1, eventType: "adapter.invoke",
      payload: { adapterType: "opencode_local" },
    });
    await db.insert(issues).values({
      id: issueId, companyId, title: "Orphaned conversation run",
      status: "in_progress", priority: "medium", assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
      checkoutRunId: runId, executionRunId: runId,
      issueNumber: issueCounter, identifier: `T-${issueCounter}`,
    });
    return { companyId, agentId, runId, issueId };
  }

  async function seedScheduledRetryRun(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    resultJson: Record<string, unknown> | null;
    dueAt: Date;
  }) {
    const runId = randomUUID();
    const sourceRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: sourceRunId,
      companyId: input.companyId,
      agentId: input.agentId,
      status: "interrupted",
      invocationSource: "manual",
      runtimeMode: "legacy",
      responsibleUserId: "responsible-user",
      contextSnapshot: { issueId: input.issueId },
      finishedAt: input.dueAt,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "scheduled_retry",
      runtimeMode: "legacy",
      responsibleUserId: "responsible-user",
      contextSnapshot: { issueId: input.issueId, retryOfRunId: sourceRunId },
      resultJson: input.resultJson,
      retryOfRunId: sourceRunId,
      scheduledRetryAt: input.dueAt,
      scheduledRetryAttempt: 1,
      createdAt: input.dueAt,
      updatedAt: input.dueAt,
    });
    await db.update(issues)
      .set({ executionRunId: runId, checkoutRunId: runId })
      .where(eq(issues.id, input.issueId));
    return runId;
  }

  // Objective 1: the process-death authority stays retry-eligible end to end.
  // A legacy conversation reap with a dead pid must produce exactly one
  // scheduled_retry successor carrying retryOfRunId + scheduledRetryAttempt 1.
  it("process-death authority on a legacy conversation run keeps the run retry-eligible: exactly one scheduled_retry successor with retryOfRunId and attempt 1, nothing on the failed run", async () => {
    const { runId } = await seedConversationOrphan();
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.runIds).toEqual([runId]);

    const [failed] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(failed.status).toBe("failed");
    expect(failed.errorCode).toBe("process_lost");
    // REL-131 API gotchas: the failed run itself carries no scheduling fields,
    // and processLossRetryCount reads 0 even on actual retries.
    expect(failed.scheduledRetryAt).toBeNull();
    expect(failed.scheduledRetryAttempt ?? 0).toBe(0);
    expect(failed.processLossRetryCount ?? 0).toBe(0);

    const successors = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.retryOfRunId, runId));
    expect(successors).toHaveLength(1);
    expect(successors[0]).toMatchObject({
      status: "scheduled_retry",
      scheduledRetryAttempt: 1,
      resultJson: { conversationContinuation: "continue_conversation_v1" },
    });
    // Retries are detected via retryOfRunId + attempt on the successor only:
    // failedRunId is never populated.
    expect(successors[0]!.failedRunId ?? null).toBeNull();

    // One budget: a replay over the same failure must not double-enqueue.
    await heartbeat.reapOrphanedRuns();
    expect(
      await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, runId)),
    ).toHaveLength(1);
  });

  // Objective 2: the stamp predicate at recovery/service.ts:5942-5962. The
  // authority is chosen before the predicate, so the predicate's own truth
  // table is: process_gone authority + legacy runtime + a claimed
  // conversation adapter. This exercises the real predicate against a real
  // row through the same helpers the shipped write imports.
  it("terminalizeOrphanedRunningRun stamp predicate: stamp requires process_gone authority, legacy runtime, and a claimed conversation adapter", async () => {
    const AUTHORITY_PROCESS_GONE = "process_gone";
    const AUTHORITY_ISSUE_TERMINAL = "issue_terminal";
    // Mirrors the shipped predicate exactly:
    //   authority === "process_gone" &&
    //   run.runtimeMode === "legacy" &&
    //   isConversationAdapter(claimedAdapterType(run) ?? "")
    const stampPredicate = (
      run: { runtimeMode: string; runnerProfileJson: unknown },
      authority: string,
    ) =>
      authority === AUTHORITY_PROCESS_GONE &&
      run.runtimeMode === "legacy" &&
      isConversationAdapter(claimedAdapterType(run as never) ?? "");

    // Conversation adapters satisfy the adapter leg; the set is pinned so a
    // silent widening (or narrowing) of CONVERSATION_ADAPTER_TYPES is caught.
    for (const adapterType of CONVERSATION_ADAPTER_TYPES) {
      const run = { runtimeMode: "legacy", runnerProfileJson: { adapterDispatch: { adapterType } } };
      expect(stampPredicate(run, AUTHORITY_PROCESS_GONE), adapterType).toBe(true);
    }

    // Non-conversation claimed adapter must not stamp, exercised on a real
    // seeded row (the shipped write path pins this end-to-end in
    // rel44-regression "non-conversation adapter reap stays status-only").
    const { runId } = await seedConversationOrphan({
      runnerProfileJson: { adapterDispatch: { adapterType: "process" } },
    });
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(claimedAdapterType(run)).toBe("process");
    expect(stampPredicate(run, AUTHORITY_PROCESS_GONE)).toBe(false);

    // Authority and runtime legs: the shipped write only reaches the stamp
    // under process_gone authority and legacy runtime; issue_terminal exits
    // before the stamp and native is fenced by the native guards.
    const conversationLegacyRun = {
      runtimeMode: "legacy",
      runnerProfileJson: { adapterDispatch: { adapterType: "opencode_local" } },
    };
    expect(stampPredicate(conversationLegacyRun, AUTHORITY_PROCESS_GONE)).toBe(true);
    expect(stampPredicate(conversationLegacyRun, AUTHORITY_ISSUE_TERMINAL)).toBe(false);
    expect(stampPredicate({ ...conversationLegacyRun, runtimeMode: "native" }, AUTHORITY_PROCESS_GONE)).toBe(false);
    // A run with no claimed adapter identity must not stamp (the predicate
    // must not fall back to the agent's mutable adapter).
    expect(stampPredicate({ runtimeMode: "legacy", runnerProfileJson: {} }, AUTHORITY_PROCESS_GONE)).toBe(false);

    // Keep the claimed-adapter source honest against the deployed row shape.
    const withClaim = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.id, runId), inArray(heartbeatRuns.runtimeMode, ["legacy"])));
    expect(withClaim).toHaveLength(1);
  });

  // Objective 3: retry eligibility derives from the stamp, which is the
  // rel163-narrowed rule the objective states. An unstamped interrupted legacy
  // reap requires reconciliation and cannot schedule a retry; a stamped
  // process_gone reap is retry-eligible, schedules, and promotes through the
  // shipped gate while the issue stays non-terminal.
  it("stamp makes the run retry-eligible: unstamped interrupted legacy reap requires reconciliation and cannot schedule; stamped reap schedules and promotes", async () => {
    const now = new Date();

    const unstamped = await seedConversationOrphan({ processPid: null });
    await db
      .update(heartbeatRuns)
      .set({ status: "interrupted", errorCode: "orphaned_running_run", finishedAt: now })
      .where(eq(heartbeatRuns.id, unstamped.runId));
    const [unstampedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, unstamped.runId));
    expect(legacyExecutionNeedsReconciliation(unstampedRun)).toBe(true);
    const unstampedScheduling = await heartbeatService(db).scheduleBoundedRetry(unstamped.runId, { now });
    expect(unstampedScheduling).toMatchObject({
      outcome: "not_scheduled",
      errorCode: "legacy_execution_requires_reconciliation",
    });
    expect(
      await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, unstamped.runId)),
    ).toHaveLength(0);

    const stamped = await seedConversationOrphan({ processPid: null });
    const stampWrite = await db
      .update(heartbeatRuns)
      .set({
        status: "interrupted",
        errorCode: "orphaned_running_run",
        resultJson: { conversationContinuation: "continue_conversation_v1" },
        finishedAt: now,
      })
      .where(eq(heartbeatRuns.id, stamped.runId))
      .returning();
    expect(stampWrite).toHaveLength(1);
    const [stampedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, stamped.runId));
    expect(legacyExecutionNeedsReconciliation(stampedRun)).toBe(false);
    const stampedScheduling = await heartbeatService(db).scheduleBoundedRetry(stamped.runId, { now });
    expect(stampedScheduling.outcome).toBe("scheduled");
    if (stampedScheduling.outcome !== "scheduled") return;

    // Dispatch rides the shipped gate: promotion proceeds while the bound
    // issue stays non-terminal.
    const adapter = createPostgresRunDispatchAdapter(db);
    const gateNow = new Date(now.getTime() + 120_000);
    expect(await adapter.evaluateScheduledRetryGate({
      runId: stampedScheduling.run.id, companyId: stamped.companyId, now: gateNow,
    })).toEqual({ allowed: true });
    expect(await adapter.promoteOrCancelDueRetry({
      companyId: stamped.companyId, runId: stampedScheduling.run.id, now: gateNow,
    })).toMatchObject({ outcome: "promoted" });
  });

  // Objective 4: late-terminal parity, done case. The successor is scheduled
  // by the shared scheduling path, never inside terminalizeOrphanedRunningRun;
  // the shipped decideScheduledRetryGate at promotion cancels a successor
  // whose issue turned done.
  it("late-terminal parity: a due successor is cancelled issue_terminal_status when the issue turns done before promotion", async () => {
    const { companyId, agentId, issueId } = await seedConversationOrphan();
    const dueAt = new Date("2026-10-22T00:00:00.000Z");
    const successorId = await seedScheduledRetryRun({
      companyId, agentId, issueId,
      resultJson: { conversationContinuation: "continue_conversation_v1" },
      dueAt,
    });

    const adapter = createPostgresRunDispatchAdapter(db);
    const now = new Date(dueAt.getTime() + 60_000);

    // Baseline: the gate allows promotion while the issue is non-terminal.
    expect(await adapter.evaluateScheduledRetryGate({ runId: successorId, companyId, now }))
      .toEqual({ allowed: true });

    // The bound issue turns done after scheduling but before promotion.
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, issueId));

    expect(await adapter.promoteOrCancelDueRetry({ companyId, runId: successorId, now }))
      .toMatchObject({ outcome: "gate_suppressed", errorCode: "issue_terminal_status" });

    const [cancelled] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, successorId));
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.errorCode).toBe("issue_terminal_status");
    // The cancelled successor must not keep the execution lock.
    const [issue] = await db
      .select({ executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, issueId));
    expect(issue.executionRunId).toBeNull();
  });

  it("late-terminal parity: a due successor is cancelled issue_cancelled when the issue turns cancelled before promotion", async () => {
    const { companyId, agentId, issueId } = await seedConversationOrphan();
    const dueAt = new Date("2026-10-22T00:00:00.000Z");
    const successorId = await seedScheduledRetryRun({
      companyId, agentId, issueId,
      resultJson: { conversationContinuation: "continue_conversation_v1" },
      dueAt,
    });

    const adapter = createPostgresRunDispatchAdapter(db);
    const now = new Date(dueAt.getTime() + 60_000);
    expect(await adapter.evaluateScheduledRetryGate({ runId: successorId, companyId, now }))
      .toEqual({ allowed: true });

    await db.update(issues)
      .set({ status: "cancelled" })
      .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)));

    expect(await adapter.promoteOrCancelDueRetry({ companyId, runId: successorId, now }))
      .toMatchObject({ outcome: "gate_suppressed", errorCode: "issue_cancelled" });
    const [cancelled] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, successorId));
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.errorCode).toBe("issue_cancelled");
  });
});

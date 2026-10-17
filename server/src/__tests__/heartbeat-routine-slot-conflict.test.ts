import { describe, expect, it } from "vitest";
import { isRoutineExecutionSlotConflict } from "../services/heartbeat.js";

const SLOT_INDEX = "issues_open_routine_execution_uq";

describe("isRoutineExecutionSlotConflict", () => {
  it("matches a DrizzleQueryError wrapping the slot unique violation", () => {
    const err = new Error(
      `Failed query: update "issues" set "execution_run_id" = $1 ... duplicate key value violates unique constraint "${SLOT_INDEX}"`,
    );
    Object.assign(err, { cause: { code: "23505", constraint: SLOT_INDEX } });
    expect(isRoutineExecutionSlotConflict(err)).toBe(true);
  });

  it("matches the postgres.js shape: constraint_name on the cause, name only in the cause message", () => {
    // Exact shape observed in production: the outer DrizzleQueryError message
    // is the failed SQL and never names the constraint.
    const err = new Error(
      'Failed query: update "issues" set "execution_run_id" = $1, "execution_agent_name_key" = $2 where ("issues"."id" = $5)\nparams: a,b',
    );
    Object.assign(err, {
      cause: {
        name: "PostgresError",
        code: "23505",
        constraint_name: SLOT_INDEX,
        message: `duplicate key value violates unique constraint "${SLOT_INDEX}"`,
      },
    });
    expect(isRoutineExecutionSlotConflict(err)).toBe(true);
  });

  it("matches a bare PostgresError carrying the constraint name", () => {
    expect(
      isRoutineExecutionSlotConflict({ code: "23505", constraint: SLOT_INDEX }),
    ).toBe(true);
  });

  it("matches on the constraint name in the message when structured fields are absent", () => {
    expect(
      isRoutineExecutionSlotConflict({
        code: "23505",
        message: `duplicate key value violates unique constraint "${SLOT_INDEX}"`,
      }),
    ).toBe(true);
  });

  it("does not match other unique violations", () => {
    expect(
      isRoutineExecutionSlotConflict({
        code: "23505",
        constraint: "issues_pkey",
        message: 'duplicate key value violates unique constraint "issues_pkey"',
      }),
    ).toBe(false);
  });

  it("does not match non-unique-violation errors", () => {
    expect(isRoutineExecutionSlotConflict(new Error("boom"))).toBe(false);
    expect(isRoutineExecutionSlotConflict({ code: "23503" })).toBe(false);
    expect(isRoutineExecutionSlotConflict(null)).toBe(false);
    expect(isRoutineExecutionSlotConflict(undefined)).toBe(false);
    expect(isRoutineExecutionSlotConflict("string failure")).toBe(false);
  });
});

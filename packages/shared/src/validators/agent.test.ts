import { describe, expect, it } from "vitest";
import { displayAgentApiKeyScope, normalizeAgentApiKeyScope, UnrecognisedAgentKeyScopeError, updateAgentSchema } from "./agent.js";

describe("agent update schema", () => {
  it.each(["paused", "idle", "terminated"])("accepts lifecycle status request %s", status => {
    expect(updateAgentSchema.parse({ status })).toEqual({ status });
  });
  it.each(["active", "running", "error", "pending_approval"])("rejects direct status write %s", status => {
    const result = updateAgentSchema.safeParse({ name: "Renamed", status });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: ["status"] }),
    ]));
  });
  it.each([{ spentMonthlyCents: 0 }, { name: "Renamed", spentMonthlyCents: 10 }])("rejects spend totals: %j", payload => {
    const result = updateAgentSchema.safeParse(payload);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: ["spentMonthlyCents"] }),
    ]));
  });
  it("accepts profile and budget limit changes", () => {
    expect(updateAgentSchema.parse({ name: "Renamed", budgetMonthlyCents: 100 })).toEqual({ name: "Renamed", budgetMonthlyCents: 100 });
  });
});

describe("agent key scope normalization (fail closed)", () => {
  it("treats a missing scope as a standard key", () => {
    expect(normalizeAgentApiKeyScope(null)).toEqual({ kind: "standard" });
    expect(normalizeAgentApiKeyScope(undefined)).toEqual({ kind: "standard" });
  });
  it("parses a valid task_bridge scope", () => {
    const projectId = "11111111-1111-4111-8111-111111111111";
    expect(normalizeAgentApiKeyScope({ kind: "task_bridge", projectId })).toEqual({ kind: "task_bridge", projectId });
  });
  it("throws instead of degrading an unparseable scope to standard", () => {
    const future = { kind: "task_bridge", projectId: "11111111-1111-4111-8111-111111111111", reportToUserId: "u" };
    expect(() => normalizeAgentApiKeyScope(future)).toThrow(UnrecognisedAgentKeyScopeError);
    expect(() => normalizeAgentApiKeyScope({ kind: "something_new" })).toThrow(UnrecognisedAgentKeyScopeError);
    expect(() => normalizeAgentApiKeyScope("garbage")).toThrow(UnrecognisedAgentKeyScopeError);
  });
  it("labels an unparseable scope as unrecognised for display, never as standard", () => {
    expect(displayAgentApiKeyScope({ kind: "something_new" })).toEqual({ kind: "unrecognised" });
    expect(displayAgentApiKeyScope(null)).toEqual({ kind: "standard" });
  });
});

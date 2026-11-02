import { describe, expect, it } from "vitest";
import { extractRemoteMcpPending } from "../services/remote-mcp-pending.js";
import { classifyRisk } from "../services/tool-access.js";

describe("remote MCP provider handoffs", () => {
  it("recognizes Arcade's JSON text authorization response before redaction", () => {
    const result = { result: { isError: true, content: [{ type: "text", text: JSON.stringify({ authorization_url: "https://github.com/login/oauth/authorize?state=test", message: "Not executed; authorize first" }) }] } };
    expect(extractRemoteMcpPending(result, "arcade")).toMatchObject({ kind: "authorization", links: [{ host: "github.com", url: "https://github.com/login/oauth/authorize?state=test" }] });
  });
  it("recognizes nested Composio connection links without treating ordinary results as handoffs", () => {
    expect(extractRemoteMcpPending({ data: { results: [{ redirect_url: "https://connect.composio.dev/link/test" }] } }, "composio", "COMPOSIO_MANAGE_CONNECTIONS")?.links).toHaveLength(1);
    expect(extractRemoteMcpPending({ url: "https://example.com/article", execution_id: "completed" }, "executor")).toBeNull();
    expect(extractRemoteMcpPending({ redirect_url: "https://example.com/article" }, "unrelated")).toBeNull();
  });
  it("recognizes Connect Hub hub_connect links only on the connection's configured hub origin", () => {
    const hubConnect = (url: string) => ({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify({ connect_url: url, expires_at: "2026-11-02T12:00:00.000Z" }) }] } });
    expect(extractRemoteMcpPending(hubConnect("https://hub.example/connect/ln_1?sig=abc"), "connecthub", "hub_connect", { endpoint: "https://hub.example/mcp" }))
      .toEqual({ kind: "authorization", links: [{ url: "https://hub.example/connect/ln_1?sig=abc", host: "hub.example" }], expiresAt: "2026-11-02T12:00:00.000Z" });
    // A foreign host is never trusted, even with the hub's path shape.
    expect(extractRemoteMcpPending(hubConnect("https://attacker.example/connect/ln_1?sig=abc"), "connecthub", "hub_connect", { endpoint: "https://hub.example/mcp" })).toBeNull();
    expect(extractRemoteMcpPending(hubConnect("https://hub.example:8443/connect/ln_1"), "connecthub", "hub_connect", { endpoint: "https://hub.example/mcp" })).toBeNull();
    // No configured endpoint, a non-https hub, another tool or another provider: no handoff.
    expect(extractRemoteMcpPending(hubConnect("https://hub.example/connect/ln_1"), "connecthub", "hub_connect")).toBeNull();
    expect(extractRemoteMcpPending(hubConnect("https://hub.example/connect/ln_1"), "connecthub", "hub_connect", { endpoint: "http://hub.example/mcp" })).toBeNull();
    expect(extractRemoteMcpPending(hubConnect("https://hub.example/connect/ln_1"), "connecthub", "github__github_get_issue", { endpoint: "https://hub.example/mcp" })).toBeNull();
    expect(extractRemoteMcpPending(hubConnect("https://hub.example/connect/ln_1"), "composio", "hub_connect", { endpoint: "https://hub.example/mcp" })).toBeNull();
  });
  it("keeps Connect Hub's -32042 URL elicitation on the generic protocol path", () => {
    const pending = extractRemoteMcpPending({ jsonrpc: "2.0", id: 1, error: { code: -32042, message: "connect", data: { elicitations: [{ mode: "url", elicitationId: "ln_9", url: "https://hub.example/connect/ln_9?sig=x", message: "Connect GitHub" }] } } }, "connecthub", "github__github_get_issue", { endpoint: "https://hub.example/mcp" });
    expect(pending).toMatchObject({ kind: "authorization", elicitationId: "ln_9", links: [{ host: "hub.example", elicitationId: "ln_9" }] });
  });
  it("refuses a Connect Hub URL elicitation whose link is not on the connection's own origin", () => {
    const elicit = (url: string) => ({ jsonrpc: "2.0", id: 1, error: { code: -32042, message: "connect", data: { elicitations: [{ mode: "url", elicitationId: "ln_9", url }] } } });
    for (const url of ["https://phish.example/connect/ln_9", "https://hub.example:8443/connect/ln_9", "http://hub.example/connect/ln_9"]) {
      expect(extractRemoteMcpPending(elicit(url), "connecthub", "github__github_get_issue", { endpoint: "https://hub.example/mcp" }), url).toBeNull();
    }
    // Without a known https endpoint there is no origin to trust.
    expect(extractRemoteMcpPending(elicit("https://hub.example/connect/ln_9"), "connecthub", "x", {})).toBeNull();
    // Other providers keep the generic elicitation behaviour.
    expect(extractRemoteMcpPending(elicit("https://provider.example/approve"), "custom", "x")).toMatchObject({ kind: "authorization" });
  });
  it("preserves URL elicitation identities and drops unsafe navigation targets", () => {
    const elicitations = [
      { mode: "url", elicitationId: "consent-1", url: "https://provider.example/approve" },
      { mode: "url", elicitationId: "consent-2", url: "javascript:alert(1)" },
      { mode: "url", elicitationId: "consent-3", url: "https://user:password@example.com" },
    ];
    const pending = extractRemoteMcpPending({ error: { code: -32042, data: { elicitations } } });
    expect(pending?.links).toEqual([{ url: "https://provider.example/approve", host: "provider.example", elicitationId: "consent-1" }]);
    expect(pending?.elicitationId).toBe("consent-1");
  });
  it("keeps an Executor execution identity for manual resume, without inventing a retry", () => {
    expect(extractRemoteMcpPending({ status: "waiting_for_interaction", executionId: "run-42", interaction: { kind: "form", message: "Approve read?", requestedSchema: { type: "object", properties: {} } } }, "executor")).toMatchObject({ kind: "approval", executionId: "run-42", resumeTool: "resume" });
  });
  it("does not turn ordinary successful app data into an approval or authorization handoff", () => {
    for (const provider of ["arcade", "composio", "executor"]) {
      for (const status of ["suspended", "pending_approval", "awaiting_approval", "waiting_for_interaction"]) {
        expect(extractRemoteMcpPending({ result: { structuredContent: { records: [{ status, executionId: "app-job", interaction: { kind: "form" }, authorization_url: "https://example.com/auth", redirect_url: "https://connect.composio.dev/link/test" }] } } }, provider, "get_records")).toBeNull();
        expect(extractRemoteMcpPending({ result: { structuredContent: { status } } }, provider, "get_record")).toBeNull();
      }
      expect(extractRemoteMcpPending({ result: { structuredContent: { mode: "url", elicitationId: "app-field", url: "https://example.com" } } }, provider)).toBeNull();
    }
  });
  it("classifies Connect Hub meta tools by review and app tools by their annotations", () => {
    expect(classifyRisk({ name: "hub_execute" }, "connecthub")).toBe("destructive");
    expect(classifyRisk({ name: "hub_execute", annotations: { readOnlyHint: true, destructiveHint: false } }, "connecthub")).toBe("destructive");
    for (const name of ["hub_list_connections", "hub_list_options", "hub_search_tools", "hub_get_tool_schema"]) expect(classifyRisk({ name, annotations: { readOnlyHint: true } }, "connecthub")).toBe("read");
    expect(classifyRisk({ name: "hub_connect", annotations: { readOnlyHint: false, destructiveHint: false } }, "connecthub")).toBe("write");
    expect(classifyRisk({ name: "google-drive__drive_list_permissions", annotations: { readOnlyHint: true } }, "connecthub")).toBe("read");
    expect(classifyRisk({ name: "gmail__gmail_send_email", annotations: { readOnlyHint: false, destructiveHint: false } }, "connecthub")).toBe("write");
    expect(classifyRisk({ name: "github__github_delete_repo", annotations: { readOnlyHint: false, destructiveHint: true } }, "connecthub")).toBe("destructive");
    expect(classifyRisk({ name: "github__github_delete_repo", annotations: { readOnlyHint: true } }, "connecthub")).toBe("destructive");
    expect(classifyRisk({ name: "acme__do_something" }, "connecthub")).toBe("write");
  });
  it("classifies broad execution and resume as writes even without annotations", () => {
    for (const name of ["execute", "resume", "edit-artifact"]) expect(classifyRisk({ name }, "executor")).toBe("write");
    expect(classifyRisk({ name: "skills", annotations: { readOnlyHint: true } }, "executor")).toBe("read");
    expect(classifyRisk({ name: "COMPOSIO_MULTI_EXECUTE_TOOL", annotations: { readOnlyHint: true } }, "composio")).toBe("write");
  });
  it("defaults unfamiliar and namespaced aggregator capabilities to writes despite read-only hints", () => {
    for (const provider of ["executor", "composio", "arcade", "zapier"]) {
      for (const name of ["vendor.execute", "custom_resume", "code", "workbench", "new_capability", "get_and_run_action"]) {
        for (const annotations of [undefined, { readOnlyHint: true }, { readOnlyHint: false }]) {
          expect(classifyRisk({ name, annotations }, provider)).toBe("write");
        }
      }
      expect(classifyRisk({ name: "delete_everything", annotations: { readOnlyHint: true } }, provider)).toBe("destructive");
    }
    for (const [provider, name] of [["executor", "skills"], ["composio", "COMPOSIO_SEARCH_TOOLS"], ["arcade", "Github.GetRepository"]]) {
      expect(classifyRisk({ name }, provider)).toBe("read");
      expect(classifyRisk({ name, annotations: { readOnlyHint: false } }, provider)).toBe("write");
      expect(classifyRisk({ name, annotations: { destructiveHint: true } }, provider)).toBe("destructive");
      expect(classifyRisk({ name: `custom.${name}`, annotations: { readOnlyHint: true } }, provider)).toBe("write");
    }
    expect(classifyRisk({ name: "GITHUB_LIST_REPOSITORIES", annotations: { readOnlyHint: true } })).toBe("read");
  });
});

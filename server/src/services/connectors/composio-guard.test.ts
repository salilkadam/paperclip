import { describe, expect, it } from "vitest";
import { composioGuardRefusal, isComposioConnection } from "./composio-guard.js";

const multi = (...items: unknown[]) => ({ tools: items });
const slug = (tool_slug: string) => ({ tool_slug, arguments: {} });
const code = (names: Array<string | null | undefined>, args: unknown) => composioGuardRefusal(names, args)?.code ?? null;

describe("composio guard", () => {
  it("recognises Composio connections by template or composio.dev host only", () => {
    expect(isComposioConnection({ config: { url: "https://connect.composio.dev/mcp" } })).toBe(true);
    expect(isComposioConnection({ config: { url: "https://backend.composio.dev/v3/mcp/x" } })).toBe(true);
    expect(isComposioConnection({ config: { sourceTemplateKey: "composio" } })).toBe(true);
    expect(isComposioConnection({ config: { url: "https://composio.dev.evil.example/mcp" } })).toBe(false);
    expect(isComposioConnection({ config: { url: "https://mcp.baisoln.com/ghost/mcp" } })).toBe(false);
    expect(isComposioConnection({ config: null })).toBe(false);
  });

  it("refuses Reddit, Hacker News and Stack Exchange writes in any item, case or padding", () => {
    for (const s of ["REDDIT_POST_REDDIT_COMMENT", "reddit_create_reddit_post", " Reddit_Delete_Comment\t",
      "STACK_EXCHANGE_CREATE_ANSWER", "stack_exchange_upvote", "HACKERNEWS_SUBMIT_STORY", "REDDIT_GETPOST"]) {
      expect(code(["COMPOSIO_MULTI_EXECUTE_TOOL"], multi(slug("REDDIT_SEARCH_ACROSS_SUBREDDITS"), slug(s)))).toBe("composio_community_write");
    }
    const many = Array.from({ length: 30 }, () => slug("REDDIT_SEARCH_ACROSS_SUBREDDITS"));
    expect(code(["COMPOSIO_MULTI_EXECUTE_TOOL"], multi(...many, slug("REDDIT_POST_REDDIT_COMMENT")))).toBe("composio_community_write");
    // a community tool exposed directly (not through multi-execute)
    expect(code(["REDDIT_POST_REDDIT_COMMENT"], {})).toBe("composio_community_write");
  });

  it("leaves reads and other apps alone", () => {
    for (const s of ["REDDIT_SEARCH_ACROSS_SUBREDDITS", "REDDIT_RETRIEVE_POST_COMMENTS", "REDDIT_RETRIEVE_REDDIT_POST",
      "STACK_EXCHANGE_SEARCH_ADVANCED", "STACK_EXCHANGE_GET_QUESTION_ANSWERS", "HACKERNEWS_GET_ITEM", "GITHUB_CREATE_AN_ISSUE"]) {
      expect(code(["COMPOSIO_MULTI_EXECUTE_TOOL"], multi({ ...slug(s), account: "work" }))).toBeNull();
    }
    for (const t of ["COMPOSIO_SEARCH_TOOLS", "COMPOSIO_GET_TOOL_SCHEMAS", "COMPOSIO_MANAGE_CONNECTIONS", "COMPOSIO_USE_SKILL"]) {
      expect(code([t], {})).toBeNull();
    }
    expect(code(["send_email", null, undefined], { tools: "anything" })).toBeNull();
  });

  it("refuses multi-execute calls it cannot read with certainty", () => {
    const unreadable = "composio_unreadable_call";
    expect(code(["COMPOSIO_MULTI_EXECUTE_TOOL"], { tools: JSON.stringify([slug("REDDIT_POST_REDDIT_COMMENT")]) })).toBe(unreadable);
    expect(code(["COMPOSIO_MULTI_EXECUTE_TOOL"], { tools: { 0: slug("REDDIT_POST_REDDIT_COMMENT") } })).toBe(unreadable);
    expect(code(["COMPOSIO_MULTI_EXECUTE_TOOL"], {})).toBe(unreadable);
    expect(code(["COMPOSIO_MULTI_EXECUTE_TOOL"], multi("REDDIT_POST_REDDIT_COMMENT"))).toBe(unreadable);
    expect(code(["COMPOSIO_MULTI_EXECUTE_TOOL"], multi({ tool: "REDDIT_POST_REDDIT_COMMENT", arguments: {} }))).toBe(unreadable);
    expect(code(["COMPOSIO_MULTI_EXECUTE_TOOL"], multi({ tool_slug: ["REDDIT_POST_REDDIT_COMMENT"], arguments: {} }))).toBe(unreadable);
    // Cyrillic "Е" lookalike
    expect(code(["COMPOSIO_MULTI_EXECUTE_TOOL"], multi(slug("RЕDDIT_POST_REDDIT_COMMENT")))).toBe(unreadable);
  });

  it("refuses the sandboxes and unreviewed meta tools under either name", () => {
    expect(code(["mcp.composio:remote-bash", "COMPOSIO_REMOTE_BASH_TOOL"], { command: "true" })).toBe("composio_sandbox");
    expect(code(["composio_remote_workbench"], {})).toBe("composio_sandbox");
    expect(code(["COMPOSIO_EXECUTE_ANYTHING"], {})).toBe("composio_unreviewed_tool");
  });
});

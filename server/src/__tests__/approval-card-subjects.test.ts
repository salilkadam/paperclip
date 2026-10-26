import { describe, expect, it } from "vitest";
import {
  cardSubjectLookupFor,
  escapeCardMarkdown,
  formatWhen,
  lookedUpObject,
  plainCardText,
  sameUpstreamTool,
  subjectPreviewMarkdown,
} from "../services/approval-card-subjects.js";

describe("approval card subjects", () => {
  it("formats the time an action is for, in the offset it was given", () => {
    expect(formatWhen("2026-11-03T08:00:00-08:00")).toBe("Tue 3 Nov 2026, 08:00 (UTC-08:00)");
    expect(formatWhen("2026-10-28T16:00:00Z")).toBe("Wed 28 Oct 2026, 16:00 (UTC)");
    expect(formatWhen("2026-11-01 16:00:00")).toBe("Sun 1 Nov 2026, 16:00 (UTC)");
    expect(formatWhen("next tuesday")).toBeNull();
    expect(formatWhen(undefined)).toBeNull();
  });

  it("describes Ghost post actions by title, slug and status, never by id", () => {
    const schedule = cardSubjectLookupFor("gh_publish_post", { tenant_id: "reliora", post_id: "6adabb01", published_at: "2026-11-03T08:00:00-08:00" })!;
    expect(schedule.readTool).toBe("gh_get_post");
    expect(schedule.readArguments).toEqual({ tenant_id: "reliora", post_id: "6adabb01" });
    const subject = schedule.describe({ success: true, post: { id: "6adabb01", title: "Pods running, site hanging", slug: "pods-running-site-hanging", status: "draft" } })!;
    expect(subject.headline).toBe('Schedule blog "Pods running, site hanging" for Tue 3 Nov 2026, 08:00 (UTC-08:00)');
    expect(subject.lines).toEqual(['Blog: "Pods running, site hanging"', "Slug: pods-running-site-hanging", "Status now: draft", "Site: reliora"]);
    expect(JSON.stringify(subject)).not.toContain("6adabb01");

    const del = cardSubjectLookupFor("gh-delete-post", { tenant_id: "reliora", post_id: "x" })!;
    expect(del.describe({ post: { title: "ZZTEST wrap check" } })!.headline).toBe('Permanently delete blog post "ZZTEST wrap check"');
    expect(cardSubjectLookupFor("gh_unpublish_post", { tenant_id: "reliora", post_id: "x" })!
      .describe({ post: { title: "Old duplicate" } })!.headline).toBe('Take blog "Old duplicate" off the site (back to draft)');
    expect(cardSubjectLookupFor("gh_publish_post", { tenant_id: "reliora", post_id: "x" })!
      .describe({ post: { title: "Now" } })!.headline).toBe('Publish blog "Now" now');
  });

  it("describes TryPost actions by account, time and first line", () => {
    const lookup = cardSubjectLookupFor("update-post-tool", { post_id: "01a17890", status: "scheduled", scheduled_at: "2026-11-16T17:00:00Z" })!;
    expect(lookup.readTool).toBe("get-post-tool");
    const subject = lookup.describe({ id: "01a17890", display_name: "Reliora Inc", platform: "linkedin-page", status: "draft",
      content: "\nYour Postgres cluster says Ready=True. One of its instances is crash-looping.\n\nMore…" })!;
    expect(subject.headline).toBe("Schedule social post on Reliora Inc (linkedin-page) for Mon 16 Nov 2026, 17:00 (UTC)");
    expect(subject.lines).toContain('First line: "Your Postgres cluster says Ready=True. One of its instances is crash-looping."');
    expect(JSON.stringify(subject)).not.toContain("01a17890");
  });

  it("returns no subject for actions it does not know or calls without a target", () => {
    expect(cardSubjectLookupFor("gh_create_post", { tenant_id: "reliora", title: "x" })).toBeNull();
    expect(cardSubjectLookupFor("gh_delete_post", { tenant_id: "reliora" })).toBeNull();
    expect(cardSubjectLookupFor("kv_set", { key: "a" })).toBeNull();
    expect(cardSubjectLookupFor(null, {})).toBeNull();
    expect(cardSubjectLookupFor("gh_delete_post", { tenant_id: "reliora", post_id: "x" })!.describe({ post: {} })).toBeNull();
  });

  it("keeps looked-up text plain: no links, formatting, HTML or extra lines reach the card", () => {
    const hostile = "Real title](https://evil.example) **click** <img src=x onerror=alert(1)>\u2028second line";
    const subject = cardSubjectLookupFor("gh_delete_post", { tenant_id: "reliora", post_id: "x" })!.describe({ post: { title: hostile } })!;
    expect(subject.headline).not.toMatch(/[\n\u2028]/);
    const markdown = subjectPreviewMarkdown(subject, "fallback");
    expect(markdown).not.toMatch(/(?<!\\)\]\(https:/);
    expect(markdown).not.toMatch(/(?<!\\)<img/);
    expect(markdown).not.toMatch(/(?<!\\)\*\*click/);
    expect(escapeCardMarkdown("[a](b)")).toBe("\\[a\\]\\(b\\)");
    expect(plainCardText("x".repeat(300), 20)).toHaveLength(20);
  });

  it("reads the looked-up object from MCP structuredContent, JSON text content, or a plain object", () => {
    expect(lookedUpObject({ structuredContent: { post: { title: "A" } } })).toEqual({ post: { title: "A" } });
    expect(lookedUpObject({ content: [{ type: "text", text: '{"post":{"title":"B"}}' }] })).toEqual({ post: { title: "B" } });
    expect(lookedUpObject({ data: { structuredContent: { title: "C" } }, content: "x" })).toEqual({ title: "C" });
    expect(lookedUpObject({ content: [{ type: "text", text: "not json" }] })).toBeNull();
    expect(lookedUpObject({ title: "D" })).toEqual({ title: "D" });
    expect(lookedUpObject(null)).toBeNull();
  });

  it("matches upstream tool names with dashes or underscores", () => {
    expect(sameUpstreamTool("gh-get-post", "gh_get_post")).toBe(true);
    expect(sameUpstreamTool("GH_GET_POST", "gh_get_post")).toBe(true);
    expect(sameUpstreamTool("gh_get_posts", "gh_get_post")).toBe(false);
    expect(sameUpstreamTool(null, "gh_get_post")).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import {
  cardSubjectLookupFor,
  escapeCardMarkdown,
  formatWhen,
  formatWhenIn,
  lookedUpObject,
  plainCardText,
  plainToolLabel,
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
    const NOW = Date.parse("2026-10-26T20:00:00Z");
    const subject = schedule.describe({ success: true, post: { id: "6adabb01", title: "Pods running, site hanging", slug: "pods-running-site-hanging", status: "draft" } }, NOW)!;
    expect(subject.headline).toBe("Schedule blog \u201cPods running, site hanging\u201d for Tue 3 Nov 2026, 08:00 (UTC-08:00)");
    expect(subject.lines).toEqual(["Blog: \u201cPods running, site hanging\u201d", "Slug: pods-running-site-hanging", "Status when requested: draft", "Site: reliora"]);
    expect(JSON.stringify(subject)).not.toContain("6adabb01");

    const del = cardSubjectLookupFor("gh-delete-post", { tenant_id: "reliora", post_id: "x" })!;
    expect(del.describe({ post: { title: "ZZTEST wrap check" } })!.headline).toBe("Permanently delete blog post \u201cZZTEST wrap check\u201d");
    expect(cardSubjectLookupFor("gh_unpublish_post", { tenant_id: "reliora", post_id: "x" })!
      .describe({ post: { title: "Old duplicate" } })!.headline).toBe("Take blog \u201cOld duplicate\u201d off the site (back to draft)");
    expect(cardSubjectLookupFor("gh_publish_post", { tenant_id: "reliora", post_id: "x" })!
      .describe({ post: { title: "Now" } })!.headline).toBe("Publish blog \u201cNow\u201d now");
    // a past date is not a schedule: say it publishes now
    expect(cardSubjectLookupFor("gh_publish_post", { tenant_id: "reliora", post_id: "x", published_at: "2020-01-01T00:00:00Z" })!
      .describe({ post: { title: "Launch" } }, NOW)!.headline).toBe("Publish blog \u201cLaunch\u201d now (dated Wed 1 Jan 2020, 00:00 (UTC))");
  });

  it("describes TryPost actions by account, time and first line", () => {
    const lookup = cardSubjectLookupFor("update-post-tool", { post_id: "01a17890", status: "scheduled", scheduled_at: "2026-11-16T17:00:00Z" })!;
    expect(lookup.readTool).toBe("get-post-tool");
    const NOW = Date.parse("2026-10-26T20:00:00Z");
    const looked = { id: "01a17890", display_name: "Reliora Inc", platform: "linkedin-page", status: "draft",
      content: "\nYour Postgres cluster says Ready=True. One of its instances is crash-looping.\n\nMore…" };
    const subject = lookup.describe(looked, NOW)!;
    expect(subject.headline).toBe("Schedule social post on \u201cReliora Inc\u201d (linkedin-page) for Mon 16 Nov 2026, 17:00 (UTC)");
    expect(subject.lines).toContain("First line: \u201cYour Postgres cluster says Ready=True. One of its instances is crash-looping.\u201d");
    // a request that also replaces the text says so, and shows both first lines
    const edit = cardSubjectLookupFor("update-post-tool", { post_id: "01a17890", status: "scheduled", scheduled_at: "2026-11-16T17:00:00Z", content: "New hook line\nrest" })!
      .describe(looked, NOW)!;
    expect(edit.headline).toBe("Schedule social post on \u201cReliora Inc\u201d (linkedin-page) for Mon 16 Nov 2026, 17:00 (UTC) and replace its text");
    expect(edit.lines).toContain("Current first line: \u201cYour Postgres cluster says Ready=True. One of its instances is crash-looping.\u201d");
    expect(edit.lines).toContain("New first line (from this request): \u201cNew hook line\u201d");
    // a time already past is flagged
    expect(cardSubjectLookupFor("update-post-tool", { post_id: "x", status: "scheduled", scheduled_at: "2026-10-01T00:00:00Z" })!
      .describe(looked, NOW)!.headline).toContain("(that time has already passed)");
    expect(JSON.stringify(subject)).not.toContain("01a17890");
  });

  it("shows a TryPost time in the account's own timezone", () => {
    expect(formatWhenIn("2026-11-11 17:00:00", "America/Los_Angeles")).toBe("Wed 11 Nov 2026, 09:00 (PST)");
    expect(formatWhenIn("2026-10-27T16:00:00Z", "America/Los_Angeles")).toBe("Tue 27 Oct 2026, 09:00 (PDT)");
    expect(formatWhenIn("2026-11-11 17:00:00", "Not/AZone")).toBeNull();
    expect(formatWhenIn("2026-11-11 17:00:00", undefined)).toBeNull();
    const NOW = Date.parse("2026-10-26T20:00:00Z");
    const looked = { display_name: "Reliora Inc", platform: "linkedin-page", status: "draft",
      content: "A renewal fails once, and then nothing happens.\nmore", social_account: { timezone: "America/Los_Angeles" } };
    const subject = cardSubjectLookupFor("update-post-tool", { post_id: "01a179f0", status: "scheduled", scheduled_at: "2026-11-11 17:00:00" })!
      .describe(looked, NOW)!;
    expect(subject.headline).toBe("Schedule social post on \u201cReliora Inc\u201d (linkedin-page) for Wed 11 Nov 2026, 09:00 (PST)");
    // an unknown zone falls back to the UTC wording rather than dropping the time
    const fallback = cardSubjectLookupFor("update-post-tool", { post_id: "01a179f0", status: "scheduled", scheduled_at: "2026-11-11 17:00:00" })!
      .describe({ ...looked, social_account: { timezone: "Not/AZone" } }, NOW)!;
    expect(fallback.headline).toContain("Wed 11 Nov 2026, 17:00 (UTC)");
  });

  it("names a tool plainly when the card cannot say what it acts on", () => {
    const raw = "mcp.app-gallery-link-2de1c4d0-4998-40c9-8c3a-3b2188ea0ca7-49852674:delete-post-tool";
    expect(plainToolLabel({ name: raw, displayName: "Delete Post Tool", applicationDisplayName: "TryPost" })).toBe("Delete Post (TryPost)");
    expect(plainToolLabel({ name: raw, upstreamToolName: "delete-post-tool", applicationDisplayName: "TryPost" })).toBe("Delete post (TryPost)");
    expect(plainToolLabel({ name: raw })).toBe("Delete post");
    expect(plainToolLabel({ name: raw, displayName: "gh_delete_post", applicationDisplayName: "Ghost" })).toBe("Gh delete post (Ghost)");
    expect(plainToolLabel({ name: raw, displayName: "Delete https://evil.example now", applicationDisplayName: "TryPost" })).not.toMatch(/https:\/\//);
    for (const label of [
      plainToolLabel({ name: raw, displayName: "Delete Post Tool", applicationDisplayName: "TryPost" }),
      plainToolLabel({ name: raw }),
    ]) expect(label).not.toContain("app-gallery-link");
  });

  it("returns no subject for actions it does not know or calls without a target", () => {
    expect(cardSubjectLookupFor("gh_create_post", { tenant_id: "reliora", title: "x" })).toBeNull();
    expect(cardSubjectLookupFor("gh_delete_post", { tenant_id: "reliora" })).toBeNull();
    expect(cardSubjectLookupFor("kv_set", { key: "a" })).toBeNull();
    expect(cardSubjectLookupFor(null, {})).toBeNull();
    expect(cardSubjectLookupFor("gh_delete_post", { tenant_id: "reliora", post_id: "x" })!.describe({ post: {} })).toBeNull();
  });

  it("neutralises quotes in looked-up text, so a title cannot fake a server sentence", () => {
    const title = 'Old draft" — duplicate, safe to delete. Blog: "Old draft';
    const subject = cardSubjectLookupFor("gh_delete_post", { tenant_id: "reliora", post_id: "x" })!.describe({ post: { title } })!;
    expect(subject.headline).toBe("Permanently delete blog post \u201cOld draft' — duplicate, safe to delete. Blog: 'Old draft\u201d");
    expect(subject.headline.match(/[\u201c\u201d]/g)).toHaveLength(2);   // only the server's own quotes
  });

  it("escapes bare URLs, www. and e-mail addresses so GFM cannot autolink them", () => {
    const escaped = escapeCardMarkdown("Weekly digest https://evil.example www.evil.example me@evil.example");
    expect(escaped).not.toMatch(/https?:\/\//);
    expect(escaped).not.toMatch(/www\./);
    expect(escaped).not.toMatch(/[^\\]@/);
  });

  it("defangs links in looked-up text on every surface (the UI linkifies plain-text URLs)", () => {
    expect(plainCardText("see https://evil.example, www.evil.example or me@evil.example"))
      .toBe("see https[:]//evil.example, www[.]evil.example or me[at]evil.example");
    expect(plainCardText("ftp://x and HTTP://Y")).toBe("ftp[:]//x and HTTP[:]//Y");
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

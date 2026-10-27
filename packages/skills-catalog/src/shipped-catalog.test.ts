import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { catalogManifest, catalogSkills, resolveCatalogSkillRef } from "./index.js";

const EXPECTED_BUNDLED_KEYS = [
  "paperclipai/bundled/docs/doc-maintenance",
  "paperclipai/bundled/paperclip-operations/issue-triage",
  "paperclipai/bundled/paperclip-operations/reflection-coach",
  "paperclipai/bundled/paperclip-operations/status-card-query",
  "paperclipai/bundled/paperclip-operations/summarize-status",
  "paperclipai/bundled/paperclip-operations/task-planning",
  "paperclipai/bundled/product/paperclip-capsules",
  "paperclipai/bundled/product/wireframe",
  "paperclipai/bundled/quality/qa-acceptance",
  "paperclipai/bundled/software-development/github-pr-workflow",
];

const EXPECTED_OPTIONAL_KEYS = [
  "paperclipai/optional/browser/agent-browser",
  "paperclipai/optional/content/release-announcement",
  "paperclipai/optional/content/simplified-english",
  "paperclipai/optional/facebook/facebook-marketing",
  "paperclipai/optional/facebook/fb-audience-insights",
  "paperclipai/optional/facebook/fb-content-planner",
  "paperclipai/optional/facebook/fb-engagement-drafter",
  "paperclipai/optional/facebook/fb-hook-extractor",
  "paperclipai/optional/facebook/fb-humanizer",
  "paperclipai/optional/facebook/fb-page-optimizer",
  "paperclipai/optional/facebook/fb-post-writer",
  "paperclipai/optional/facebook/fb-repurposer",
  "paperclipai/optional/finance/ramp",
  "paperclipai/optional/instagram/ig-audience-insights",
  "paperclipai/optional/instagram/ig-caption-writer",
  "paperclipai/optional/instagram/ig-carousel-planner",
  "paperclipai/optional/instagram/ig-content-planner",
  "paperclipai/optional/instagram/ig-hashtag-strategist",
  "paperclipai/optional/instagram/ig-hook-extractor",
  "paperclipai/optional/instagram/ig-humanizer",
  "paperclipai/optional/instagram/ig-profile-optimizer",
  "paperclipai/optional/instagram/ig-repurposer",
  "paperclipai/optional/instagram/instagram-marketing",
  "paperclipai/optional/linkedin/linkedin-comment-drafter",
  "paperclipai/optional/linkedin/linkedin-content-planner",
  "paperclipai/optional/linkedin/linkedin-employee-advocacy",
  "paperclipai/optional/linkedin/linkedin-engager-analytics",
  "paperclipai/optional/linkedin/linkedin-hook-extractor",
  "paperclipai/optional/linkedin/linkedin-humanizer",
  "paperclipai/optional/linkedin/linkedin-interviewer",
  "paperclipai/optional/linkedin/linkedin-marketing",
  "paperclipai/optional/linkedin/linkedin-post-writer",
  "paperclipai/optional/linkedin/linkedin-profile-optimizer",
  "paperclipai/optional/linkedin/linkedin-reply-handler",
  "paperclipai/optional/linkedin/linkedin-repurposer",
  "paperclipai/optional/linkedin/linkedin-thread-monitor",
  "paperclipai/optional/product/design-critique",
  "paperclipai/optional/research/last30days",
  "paperclipai/optional/social/social-core",
  "paperclipai/optional/software-development/prepare-mcp-integration",
  "paperclipai/optional/threads/threads-audience-insights",
  "paperclipai/optional/threads/threads-content-planner",
  "paperclipai/optional/threads/threads-hook-extractor",
  "paperclipai/optional/threads/threads-humanizer",
  "paperclipai/optional/threads/threads-marketing",
  "paperclipai/optional/threads/threads-post-writer",
  "paperclipai/optional/threads/threads-profile-optimizer",
  "paperclipai/optional/threads/threads-reply-drafter",
  "paperclipai/optional/threads/threads-repurposer",
  "paperclipai/optional/tiktok/tiktok-marketing",
  "paperclipai/optional/tiktok/tt-audience-insights",
  "paperclipai/optional/tiktok/tt-caption-writer",
  "paperclipai/optional/tiktok/tt-content-planner",
  "paperclipai/optional/tiktok/tt-hook-scripter",
  "paperclipai/optional/tiktok/tt-humanizer",
  "paperclipai/optional/tiktok/tt-profile-optimizer",
  "paperclipai/optional/tiktok/tt-repurposer",
  "paperclipai/optional/tiktok/tt-trend-mapper",
  "paperclipai/optional/x/x-audience-insights",
  "paperclipai/optional/x/x-content-planner",
  "paperclipai/optional/x/x-hook-extractor",
  "paperclipai/optional/x/x-humanizer",
  "paperclipai/optional/x/x-marketing",
  "paperclipai/optional/x/x-post-writer",
  "paperclipai/optional/x/x-profile-optimizer",
  "paperclipai/optional/x/x-reply-drafter",
  "paperclipai/optional/x/x-repurposer",
  "paperclipai/optional/x/x-thread-builder",
  "paperclipai/optional/youtube/youtube-marketing",
  "paperclipai/optional/youtube/yt-audience-insights",
  "paperclipai/optional/youtube/yt-channel-optimizer",
  "paperclipai/optional/youtube/yt-community-post-writer",
  "paperclipai/optional/youtube/yt-content-planner",
  "paperclipai/optional/youtube/yt-description-writer",
  "paperclipai/optional/youtube/yt-hook-scripter",
  "paperclipai/optional/youtube/yt-repurposer",
  "paperclipai/optional/youtube/yt-thumbnail-brief",
  "paperclipai/optional/youtube/yt-title-optimizer",
];

const SOCIAL_CATEGORIES = ["social", "linkedin", "x", "instagram", "youtube", "threads", "tiktok", "facebook"];

const MAX_FRONTMATTER_DESCRIPTION_LENGTH = 300;
const REPO_ROOT = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const SKILL_FRONTMATTER_ROOTS = [
  path.join(REPO_ROOT, ".agents"),
  path.join(REPO_ROOT, "skills"),
  path.join(REPO_ROOT, "packages/adapters"),
  path.join(REPO_ROOT, "packages/plugins"),
  path.join(REPO_ROOT, "packages/skills-catalog/catalog"),
  path.join(REPO_ROOT, "packages/teams-catalog/catalog"),
];

function listSkillFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    // Standalone provider installs can contain third-party skills. They are not
    // shipped Paperclip skills and must not participate in this repo audit.
    if (entry.name === "node_modules") return [];
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return listSkillFiles(entryPath);
    if (entry.isFile() && entry.name === "SKILL.md") return [entryPath];
    return [];
  });
}

function readFrontmatterDescription(markdown: string): string | null {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;

  const lines = match[1]!.split(/\r?\n/);
  const descriptionIndex = lines.findIndex((line) => line.startsWith("description:"));
  if (descriptionIndex === -1) return null;

  const inlineValue = lines[descriptionIndex]!.slice("description:".length).trim();
  if (/^[>|][+-]?$/.test(inlineValue)) {
    const descriptionLines: string[] = [];
    for (let index = descriptionIndex + 1; index < lines.length; index += 1) {
      const line = lines[index]!;
      if (/^[A-Za-z0-9_-]+:/.test(line)) break;
      descriptionLines.push(line.trim());
    }
    return descriptionLines.join(" ").replace(/\s+/g, " ").trim();
  }

  return inlineValue.replace(/^['"]|['"]$/g, "");
}

describe("shipped skills catalog", () => {
  it("ships the summarize-status streaming protocol", () => {
    const skill = readFileSync(
      path.join(
        REPO_ROOT,
        "packages/skills-catalog/catalog/bundled/paperclip-operations/summarize-status/SKILL.md",
      ),
      "utf8",
    );

    expect(skill).toContain("Post the first status update immediately, before doing anything else.");
    expect(skill).toContain('STATUS: considering "Fix login redirect loop"…');
    expect(skill).toContain("<<<SUMMARY-DRAFT>>>");
    expect(skill).toContain("<<<END-SUMMARY-DRAFT>>>");
    expect(skill).toContain("tool-call arguments don't stream; assistant text does");
    expect(skill).toContain("falls back to its spinner");
    expect(skill).toContain("Open with what the reader needs to do.");
    expect(skill).toContain("1–3 specific, concrete, actionable items");
  });

  it("keeps repo and catalog skill descriptions within the prompt budget cap", () => {
    const violations: string[] = [];
    for (const skillFile of SKILL_FRONTMATTER_ROOTS.flatMap(listSkillFiles)) {
      const description = readFrontmatterDescription(readFileSync(skillFile, "utf8"));
      if (!description) {
        violations.push(`${path.relative(REPO_ROOT, skillFile)} is missing a frontmatter description`);
      } else if (description.length > MAX_FRONTMATTER_DESCRIPTION_LENGTH) {
        violations.push(`${path.relative(REPO_ROOT, skillFile)} description is ${description.length} chars`);
      }
    }
    for (const skill of catalogSkills) {
      if (skill.description.length > MAX_FRONTMATTER_DESCRIPTION_LENGTH) {
        violations.push(`${skill.key} generated description is ${skill.description.length} chars`);
      }
    }

    expect(violations).toEqual([]);
  });

  it("ships the expected bundled and optional skill set", () => {
    const bundledKeys = catalogSkills
      .filter((skill) => skill.kind === "bundled")
      .map((skill) => skill.key)
      .sort();
    const optionalKeys = catalogSkills
      .filter((skill) => skill.kind === "optional")
      .map((skill) => skill.key)
      .sort();

    expect(bundledKeys).toEqual(EXPECTED_BUNDLED_KEYS);
    expect(optionalKeys).toEqual(EXPECTED_OPTIONAL_KEYS);
  });

  it("keeps script-bearing shipped skills explicit so install stays audit-gated", () => {
    // The real install-time security boundary audits materialized bytes and blocks
    // hard-stop findings. Static assets (svg/html templates, e.g. the wireframe skill)
    // carry the "assets" trust level and are installable.
    const scriptBearing = catalogSkills.filter((skill) => skill.trustLevel === "scripts_executables");
    expect(scriptBearing.map((skill) => skill.key)).toEqual([
      "paperclipai/optional/research/last30days",
    ]);
  });

  it("populates browse/search-relevant fields for every shipped skill", () => {
    const issues: string[] = [];
    for (const skill of catalogSkills) {
      if (skill.compatibility !== "compatible") {
        issues.push(`${skill.key} compatibility=${skill.compatibility}`);
      }
      if (!skill.description || skill.description.length < 40) {
        issues.push(`${skill.key} description must be at least 40 characters for catalog browse/search`);
      }
      if (skill.recommendedForRoles.length === 0) {
        issues.push(`${skill.key} must list recommendedForRoles`);
      }
      if (skill.tags.length === 0) {
        issues.push(`${skill.key} must list tags`);
      }
    }
    expect(issues).toEqual([]);
  });

  it("uses canonical paperclipai keys derived from kind/category/slug", () => {
    const violations: string[] = [];
    for (const skill of catalogSkills) {
      const expectedKey = `paperclipai/${skill.kind}/${skill.category}/${skill.slug}`;
      const expectedId = `paperclipai:${skill.kind}:${skill.category}:${skill.slug}`;
      if (skill.key !== expectedKey) violations.push(`${skill.key} should be ${expectedKey}`);
      if (skill.id !== expectedId) violations.push(`${skill.id} should be ${expectedId}`);
    }
    expect(violations).toEqual([]);
  });

  it("exposes a stable manifest header for downstream consumers", () => {
    expect(catalogManifest.schemaVersion).toBe(1);
    expect(catalogManifest.packageName).toBe("@paperclipai/skills-catalog");
    expect(catalogSkills.length).toBe(EXPECTED_BUNDLED_KEYS.length + EXPECTED_OPTIONAL_KEYS.length);
  });

  it("resolves shipped skills by id, key, and unique slug", () => {
    const sample = catalogSkills.find((skill) => skill.key === "paperclipai/bundled/software-development/github-pr-workflow");
    expect(sample, "expected github-pr-workflow to ship in the bundled catalog").toBeDefined();
    if (!sample) return;

    expect(resolveCatalogSkillRef(sample.id)).toMatchObject({ key: sample.key });
    expect(resolveCatalogSkillRef(sample.key)).toMatchObject({ key: sample.key });
    expect(resolveCatalogSkillRef(sample.slug)).toMatchObject({ key: sample.key });
  });

  it("keeps the social channel packs on in-house tools with recorded provenance", () => {
    // Adapted from third-party bundles that publish through Publora and run
    // Python helpers. Paperclip publishes only through TryPost approval cards,
    // so any leftover upstream plumbing is a second, ungated path.
    const upstreamPlumbing = /publora|pixfaro|pip install|requirements\.txt|APIFY_TOKEN|YOUTUBE_API_KEY|CUSTOM_POSTER|\.env\b|\blib\.[a-z_]+\(|\.\.\/\.\.\/references/i;
    const violations: string[] = [];
    const socialSkills = catalogSkills.filter((skill) => SOCIAL_CATEGORIES.includes(skill.category));
    expect(new Set(socialSkills.map((skill) => skill.category))).toEqual(new Set(SOCIAL_CATEGORIES));
    for (const skill of socialSkills) {
      const skillDir = path.join(REPO_ROOT, "packages/skills-catalog", skill.path);
      if (skill.trustLevel === "scripts_executables") violations.push(`${skill.key} ships scripts`);
      for (const file of skill.files) {
        if (file.path === "UPSTREAM.md") continue;
        const text = readFileSync(path.join(skillDir, file.path), "utf8");
        const match = text.match(upstreamPlumbing);
        if (match) violations.push(`${skill.key}/${file.path} mentions "${match[0]}"`);
        // Going live is one approval-gated update-post-tool request (social-core
        // section 2); no skill may name a tool that publishes or moves posts.
        const goLive = text.match(/\b(?:publish|approve|reject|delete)-post-tool\b|\bmove-post-to-slot-tool\b|\bset-post-recurrence-tool\b|\breorder-queue-tool\b|-posting-schedule-tool\b|-repurpose-tool\b/);
        if (goLive) violations.push(`${skill.key}/${file.path} names go-live tool "${goLive[0]}"`);
        for (const create of text.matchAll(/\bcreate-posts?-tool\b/g)) {
          const around = text.slice(Math.max(0, create.index - 300), create.index + 300);
          if (!/"draft"|status: draft|cannot/.test(around)) {
            violations.push(`${skill.key}/${file.path} calls ${create[0]} without status "draft"`);
          }
        }
      }
      const entry = readFileSync(path.join(skillDir, "SKILL.md"), "utf8");
      if (skill.slug !== "social-core" && !entry.includes("`social-core`")) {
        violations.push(`${skill.key} must defer to social-core`);
      }
      if (skill.slug === `${skill.category}-marketing`) {
        const upstream = skill.files.some((file) => file.path === "UPSTREAM.md")
          ? readFileSync(path.join(skillDir, "UPSTREAM.md"), "utf8")
          : "";
        if (!/\b[0-9a-f]{40}\b/.test(upstream) || !upstream.includes("MIT License")) {
          violations.push(`${skill.key} must record the pinned upstream commit and MIT licence in UPSTREAM.md`);
        }
      }
    }
    for (const channel of SOCIAL_CATEGORIES.filter((category) => category !== "social")) {
      if (!socialSkills.some((skill) => skill.key === `paperclipai/optional/${channel}/${channel}-marketing`)) {
        violations.push(`${channel} has no ${channel}-marketing hub`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("keeps the Ramp wrapper fail-closed on mixed-provenance playbooks", () => {
    const rampSkill = readFileSync(new URL("../catalog/optional/finance/ramp/SKILL.md", import.meta.url), "utf8");

    expect(rampSkill).toContain("mixes Official and Community playbooks");
    expect(rampSkill).toContain("do not execute them inside Paperclip unless a Paperclip approval explicitly names the playbook");
    expect(rampSkill).toContain("third-party browser automation, MCP server, CLI, or connector");
  });

  it("keeps the Ramp wrapper clear of remote-fetch execution hard-stop patterns", () => {
    const rampSkill = readFileSync(new URL("../catalog/optional/finance/ramp/SKILL.md", import.meta.url), "utf8");
    const remoteExecPattern = /\b(?:curl|wget)\b[\s\S]{0,160}\|\s*(?:sh|bash)|\b(?:bash|sh)\s+-c\b|\beval\b|\bpython\s+-c\b|\bnode\s+-e\b/i;

    expect(remoteExecPattern.test(rampSkill)).toBe(false);
  });
});

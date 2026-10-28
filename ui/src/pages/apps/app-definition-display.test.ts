import { describe, expect, it } from "vitest";
import type { ToolConnection } from "@paperclipai/shared";
import { galleryEntryByName, type AppGalleryDisplayEntry } from "./app-definition-display";

const tryPost = {
  slug: "trypost",
  name: "TryPost",
  urlPatterns: ["https://app.trypost.it/*"],
} as unknown as AppGalleryDisplayEntry;

const patternless = {
  slug: "notion",
  name: "Notion",
  urlPatterns: [],
} as unknown as AppGalleryDisplayEntry;

function connectionAt(url: string | null): ToolConnection {
  return { config: url ? { url } : {}, transportConfig: {} } as unknown as ToolConnection;
}

describe("galleryEntryByName", () => {
  it("does not treat a self-hosted server that shares a curated app's name as that app", () => {
    expect(galleryEntryByName([tryPost], "TryPost", connectionAt("https://socialx.baisoln.com/mcp/trypost"))).toBeNull();
  });

  it("matches by name when the server URL fits the curated app's patterns", () => {
    expect(galleryEntryByName([tryPost], "trypost", connectionAt("https://app.trypost.it/mcp/trypost"))).toBe(tryPost);
  });

  it("keeps the name match when there is no URL to check or the app lists no patterns", () => {
    expect(galleryEntryByName([tryPost], "TryPost", connectionAt(null))).toBe(tryPost);
    expect(galleryEntryByName([patternless], "Notion", connectionAt("https://mcp.notion.com/mcp"))).toBe(patternless);
  });

  it("returns null for an unknown or empty name", () => {
    expect(galleryEntryByName([tryPost], "SocialX TryPost", connectionAt(null))).toBeNull();
    expect(galleryEntryByName([tryPost], "  ", connectionAt(null))).toBeNull();
    expect(galleryEntryByName([tryPost], undefined, undefined)).toBeNull();
  });
});

import { describe, expect, it } from "vitest";

import { imapQuote, parseCapability, parseFetchEntries, parseSearchUids, toUidSet } from "./imap.js";

describe("parseSearchUids", () => {
  it("reads, dedupes and sorts uids from SEARCH responses", () => {
    expect(parseSearchUids([{ line: "* SEARCH 3 4 5" }])).toEqual([3, 4, 5]);
    expect(parseSearchUids([{ line: "* SEARCH" }])).toEqual([]);
    expect(parseSearchUids([{ line: "* SEARCH 5" }, { line: "* SEARCH 2 5" }])).toEqual([2, 5]);
    expect(parseSearchUids([])).toEqual([]);
  });

  it("ignores every other untagged response", () => {
    expect(parseSearchUids([{ line: "* 12 EXISTS" }, { line: "* OK [READ-WRITE] SELECT completed" }])).toEqual([]);
    expect(parseSearchUids([{ line: "* SEARCH 9 not-a-number" }])).toEqual([9]);
  });
});

describe("parseCapability", () => {
  it("lowercases the capability list and drops the keyword", () => {
    expect(parseCapability([{ line: "* CAPABILITY IMAP4rev1 LOGINDISABLED STARTTLS" }])).toEqual([
      "imap4rev1",
      "logindisabled",
      "starttls",
    ]);
  });

  it("returns nothing when the server did not answer CAPABILITY", () => {
    expect(parseCapability([{ line: "* OK hello" }])).toEqual([]);
  });
});

describe("parseFetchEntries", () => {
  it("pairs a FETCH response with its uid, flags and literal", () => {
    const raw = Buffer.from("From: a@b.example\r\n\r\nbody", "utf8");
    const entries = parseFetchEntries([
      { line: "* 2 FETCH (UID 12 FLAGS (\\Seen) BODY[] ", literal: raw },
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.uid).toBe(12);
    expect(entries[0]?.flags).toEqual(["\\Seen"]);
    expect(entries[0]?.raw.toString("utf8")).toBe("From: a@b.example\r\n\r\nbody");
  });

  it("recovers flags that a line-wrapping server sent after the literal", () => {
    const entries = parseFetchEntries([
      { line: "* 7 FETCH (UID 7 BODY[] ", literal: Buffer.from("hello") },
      { line: "FLAGS (\\Seen \\Flagged))" },
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.uid).toBe(7);
    expect(entries[0]?.flags).toEqual(["\\Seen", "\\Flagged"]);
    expect(entries[0]?.raw.toString()).toBe("hello");
  });

  it("reports no flags for a fresh message", () => {
    const entries = parseFetchEntries([
      { line: "* 1 FETCH (UID 11 FLAGS () BODY[] ", literal: Buffer.from("x") },
    ]);
    expect(entries[0]?.flags).toEqual([]);
    expect(entries[0]?.uid).toBe(11);
  });

  it("ignores non-FETCH responses and FETCHes with no literal", () => {
    expect(parseFetchEntries([{ line: "* 4 EXISTS" }, { line: "* 4 FETCH (FLAGS (\\Seen))" }])).toEqual([]);
  });

  it("does not treat a tagged response as a continuation", () => {
    const entries = parseFetchEntries([
      { line: "* 1 FETCH (UID 5 BODY[] ", literal: Buffer.from("y") },
      { line: "A0001 OK FETCH completed" },
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.flags).toEqual([]);
  });
});

describe("toUidSet", () => {
  it("collapses contiguous runs so one poll is cheap", () => {
    expect(toUidSet([7])).toBe("7");
    expect(toUidSet([1, 2, 3])).toBe("1:3");
    expect(toUidSet([4, 1, 2, 8, 7])).toBe("1:2,4,7:8");
    expect(toUidSet([3, 3, 3])).toBe("3");
  });

  it("returns an empty set for no uids", () => {
    expect(toUidSet([])).toBe("");
  });
});

describe("imapQuote", () => {
  it("escapes quotes and backslashes so arguments stay one token", () => {
    expect(imapQuote("plain")).toBe('"plain"');
    expect(imapQuote('say "hi"')).toBe('"say \\"hi\\""');
    expect(imapQuote("back\\slash")).toBe('"back\\\\slash"');
    expect(imapQuote("pässwörd")).toBe('"pässwörd"');
  });
});

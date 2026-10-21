/**
 * Operator allowlist for plugin HTTP to private hosts
 * (PAPERCLIP_PLUGIN_HTTP_ALLOWED_PRIVATE_HOSTS). The default remains: every
 * private/reserved address is refused. An allowlisted hostname, for the named
 * plugin only, may resolve to RFC 1918 / ULA space — never to loopback,
 * link-local (cloud metadata) or unspecified addresses.
 */
import { describe, expect, it, vi } from "vitest";

const lookup = vi.hoisted(() => vi.fn());
vi.mock("node:dns/promises", async (orig) => ({ ...(await orig<object>()), lookup }));

import { privateHostAllowlistFor, resolvePluginFetchTarget, validateAndResolveFetchUrl } from "../services/plugin-host-services.js";

const ENV = "paperclip.ghost-blog=ghost-bionic.blog.svc.cluster.local, Ghost-Reliora.blog.svc.cluster.local.;other.plugin=db.internal";

describe("privateHostAllowlistFor", () => {
  it("scopes hosts to the named plugin, normalised", () => {
    expect([...privateHostAllowlistFor("paperclip.ghost-blog", ENV)].sort()).toEqual([
      "ghost-bionic.blog.svc.cluster.local",
      "ghost-reliora.blog.svc.cluster.local",
    ]);
    expect([...privateHostAllowlistFor("other.plugin", ENV)]).toEqual(["db.internal"]);
    expect(privateHostAllowlistFor("paperclip.unlisted", ENV).size).toBe(0);
    expect(privateHostAllowlistFor("paperclip.ghost-blog", undefined).size).toBe(0);
  });

  it("ignores wildcards, IP literals and junk", () => {
    const set = privateHostAllowlistFor("p", "p=*.svc.cluster.local,10.0.0.5,169.254.169.254,bad host,ok.internal");
    expect([...set]).toEqual(["ok.internal"]);
  });
});

describe("validateAndResolveFetchUrl with an allowlist", () => {
  const allow = new Set(["ghost-bionic.blog.svc.cluster.local"]);

  it("still refuses private addresses by default", async () => {
    lookup.mockResolvedValueOnce([{ address: "10.43.1.2", family: 4 }]);
    await expect(validateAndResolveFetchUrl("http://ghost-bionic.blog.svc.cluster.local:2368/"))
      .rejects.toThrow(/private\/reserved/);
  });

  it("lets an allowlisted host resolve to a private address, pinned", async () => {
    lookup.mockResolvedValueOnce([{ address: "10.43.1.2", family: 4 }]);
    const t = await validateAndResolveFetchUrl("http://ghost-bionic.blog.svc.cluster.local:2368/x", allow);
    expect(t.resolvedAddress).toBe("10.43.1.2");
    expect(t.hostHeader).toBe("ghost-bionic.blog.svc.cluster.local:2368");
  });

  it("never allows loopback, link-local or unspecified, even when allowlisted", async () => {
    for (const address of ["127.0.0.1", "169.254.169.254", "0.0.0.0", "0.1.2.3", "::1", "fe80::1", "::ffff:127.0.0.1",
                           "::127.0.0.1", "64:ff9b::7f00:1", "fd00:ec2::254", "100.100.100.200", "8.8.8.8", "fec0::1"]) {
      lookup.mockResolvedValueOnce([{ address, family: address.includes(":") ? 6 : 4 }]);
      await expect(validateAndResolveFetchUrl("http://ghost-bionic.blog.svc.cluster.local/", allow))
        .rejects.toThrow(/private\/reserved/);
    }
  });

  it("does not extend to other hostnames", async () => {
    lookup.mockResolvedValueOnce([{ address: "10.43.9.9", family: 4 }]);
    await expect(validateAndResolveFetchUrl("http://ghost-reliora.blog.svc.cluster.local/", allow))
      .rejects.toThrow(/private\/reserved/);
  });
});

describe("mixed DNS answers for an allowlisted host", () => {
  it("one stray answer fails the whole request", async () => {
    lookup.mockResolvedValueOnce([{ address: "10.43.1.2", family: 4 }, { address: "169.254.169.254", family: 4 }]);
    await expect(validateAndResolveFetchUrl("http://ghost-bionic.blog.svc.cluster.local/", new Set(["ghost-bionic.blog.svc.cluster.local"])))
      .rejects.toThrow(/private\/reserved/);
  });
});

describe("resolvePluginFetchTarget (the fetch handler's call site)", () => {
  const env = "paperclip.ghost-blog=ghost-bionic.blog.svc.cluster.local";
  it("applies the CALLING plugin's allowlist", async () => {
    lookup.mockResolvedValueOnce([{ address: "10.43.1.2", family: 4 }]);
    const t = await resolvePluginFetchTarget("paperclip.ghost-blog", "http://ghost-bionic.blog.svc.cluster.local:2368/", env);
    expect(t.resolvedAddress).toBe("10.43.1.2");
  });
  it("gives another plugin nothing", async () => {
    lookup.mockResolvedValueOnce([{ address: "10.43.1.2", family: 4 }]);
    await expect(resolvePluginFetchTarget("evil.plugin", "http://ghost-bionic.blog.svc.cluster.local:2368/", env))
      .rejects.toThrow(/private\/reserved/);
  });
});

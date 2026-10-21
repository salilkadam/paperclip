/**
 * The REAL plugin http.fetch handler (buildHostServices(...).http.fetch) must
 * apply the CALLING plugin's private-host allowlist, and nothing else. DNS and
 * the outbound socket are mocked: the test observes where the handler would
 * connect, so reverting the handler to an unscoped validator fails here.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const lookup = vi.hoisted(() => vi.fn());
const connects = vi.hoisted(() => [] as Array<{ host?: string; headers?: Record<string, unknown> }>);
vi.mock("node:dns/promises", async (orig) => ({ ...(await orig<object>()), lookup }));
vi.mock("node:http", async (orig) => {
  const actual = await orig<typeof import("node:http")>();
  const { EventEmitter } = await import("node:events");
  return {
    ...actual,
    request: (options: { host?: string; hostname?: string; headers?: Record<string, unknown> }) => {
      connects.push({ host: options.hostname ?? options.host, headers: options.headers });
      const req = new EventEmitter() as EventEmitter & { end(): void; write(): void; destroy(): void };
      req.write = () => {};
      req.destroy = () => {};
      req.end = () => queueMicrotask(() => req.emit("error", new Error("MOCK_SOCKET")));
      return req;
    },
  };
});
vi.mock("../instrumentation.js", () => ({ recordProviderPluginSpan: vi.fn() }));

import { buildHostServices } from "../services/plugin-host-services.js";

const bus = { forPlugin: () => ({ emit: vi.fn(), subscribe: vi.fn() }) } as never;
const ENV = "paperclip.ghost-blog=ghost-bionic.blog.svc.cluster.local";

afterEach(() => {
  vi.unstubAllEnvs();
  connects.length = 0;
});

async function fetchAs(pluginKey: string, url: string) {
  const services = buildHostServices({} as never, "record-id", pluginKey, bus);
  return services.http.fetch({ url, init: { method: "GET" } } as never);
}

describe("plugin http.fetch handler", () => {
  it("lets the allowlisted plugin connect to the pinned private address", async () => {
    vi.stubEnv("PAPERCLIP_PLUGIN_HTTP_ALLOWED_PRIVATE_HOSTS", ENV);
    lookup.mockResolvedValueOnce([{ address: "10.43.37.34", family: 4 }]);
    await expect(fetchAs("paperclip.ghost-blog", "http://ghost-bionic.blog.svc.cluster.local:2368/ghost/api/admin/site/"))
      .rejects.toThrow(/MOCK_SOCKET/);   // got as far as the socket
    expect(connects.map((c) => c.host)).toEqual(["10.43.37.34"]);
  });

  it("refuses the same host for any other plugin, before any socket", async () => {
    vi.stubEnv("PAPERCLIP_PLUGIN_HTTP_ALLOWED_PRIVATE_HOSTS", ENV);
    lookup.mockResolvedValueOnce([{ address: "10.43.37.34", family: 4 }]);
    await expect(fetchAs("other.plugin", "http://ghost-bionic.blog.svc.cluster.local:2368/"))
      .rejects.toThrow(/private\/reserved/);
    expect(connects).toHaveLength(0);
  });

  it("refuses it for the right plugin when the allowlist is unset", async () => {
    lookup.mockResolvedValueOnce([{ address: "10.43.37.34", family: 4 }]);
    await expect(fetchAs("paperclip.ghost-blog", "http://ghost-bionic.blog.svc.cluster.local:2368/"))
      .rejects.toThrow(/private\/reserved/);
    expect(connects).toHaveLength(0);
  });
});

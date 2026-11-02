// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolConnection } from "@paperclipai/shared";
import type { AggregatorAppsResponse } from "@paperclipai/shared/aggregator-apps";
import { AggregatorAppManager } from "./AggregatorAppManager";

const listAggregatorAppsMock = vi.hoisted(() => vi.fn());
const setupAggregatorAppMock = vi.hoisted(() => vi.fn());

vi.mock("@/api/tools", () => ({
  toolsApi: {
    listAggregatorApps: (connectionId: string) => listAggregatorAppsMock(connectionId),
    refreshAggregatorApps: vi.fn(),
    setupAggregatorApp: (connectionId: string, toolkit: string, input: unknown) => setupAggregatorAppMock(connectionId, toolkit, input),
  },
}));
vi.mock("@/api/companies-query", () => ({ useAccountIdentity: () => ({ userId: "user-1", settled: true }) }));
vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: React.ReactNode }) => <a href={to} {...props}>{children}</a>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const HUB = "https://hub.example";
const connection = { id: "hub-1", name: "Connect Hub", config: { sourceTemplateKey: "connecthub", url: `${HUB}/mcp` } } as unknown as ToolConnection;
const app = { slug: "github", name: "GitHub", aliases: [], routes: [] };
function inventory(accounts: AggregatorAppsResponse["apps"][number]["accounts"]): AggregatorAppsResponse {
  return {
    provider: "connecthub",
    discovery: { availability: "available", message: null },
    sync: { status: "ready", coverage: "gateway_tools", checked: 1, total: 1, failed: 0, lastCompletedAt: new Date().toISOString(), error: null },
    apps: [{ provider: "connecthub", connectionId: "hub-1", toolkit: "github", appSlug: "github", appName: "GitHub", status: accounts.length ? "connected" : "not_connected",
      freshness: "fresh", accounts, checkedAt: new Date().toISOString(), errorAt: null }],
  };
}

describe("AggregatorAppManager with Connect Hub", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });
  async function render() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(<QueryClientProvider client={client}><AggregatorAppManager app={app} connections={[connection]} onClose={() => undefined} /></QueryClientProvider>);
    });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  }
  const button = (text: string) => [...document.querySelectorAll("button")].find(candidate => candidate.textContent?.includes(text));

  it("starts the hub connect handoff and shows the hub's own link", async () => {
    listAggregatorAppsMock.mockResolvedValue(inventory([]));
    setupAggregatorAppMock.mockResolvedValue({ status: "authorization_required", authorizationUrl: `${HUB}/connect/ln_1?sig=abc` });
    await render();
    const open = [...document.querySelectorAll("a")].find(anchor => anchor.textContent?.includes("Open in Connect Hub"));
    expect(open?.getAttribute("href")).toBe(`${HUB}/dashboard`);
    await act(async () => { button("Connect GitHub")!.click(); });
    expect(setupAggregatorAppMock).toHaveBeenCalledWith("hub-1", "github", { action: "start" });
    const link = [...document.querySelectorAll("a")].find(anchor => anchor.textContent?.includes("Connect GitHub in Connect Hub"));
    expect(link?.getAttribute("href")).toBe(`${HUB}/connect/ln_1?sig=abc`);
    await act(async () => { button("I’ve connected it")!.click(); });
    expect(setupAggregatorAppMock).toHaveBeenLastCalledWith("hub-1", "github", { action: "complete" });
  });

  it("offers no connect action once the app has an active hub account", async () => {
    listAggregatorAppsMock.mockResolvedValue(inventory([{ id: "ca_1", alias: "octocat", status: "ACTIVE", isDefault: false, appSlug: "github", appName: "GitHub", managementUrl: `${HUB}/dashboard` }]));
    await render();
    expect(document.body.textContent).toContain("octocat");
    expect(document.body.textContent).toContain("Connected");
    expect(button("Connect GitHub")).toBeUndefined();
  });
});

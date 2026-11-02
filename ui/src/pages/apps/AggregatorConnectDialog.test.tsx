// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolConnection } from "@paperclipai/shared";
import { AGGREGATOR_APP_CATALOG } from "@paperclipai/shared/aggregator-app-catalog";
import { AggregatorConnectDialog } from "./AggregatorConnectDialog";

const setupAggregatorAppMock = vi.hoisted(() => vi.fn());
vi.mock("@/api/tools", () => ({
  toolsApi: { setupAggregatorApp: (id: string, toolkit: string, input: unknown) => setupAggregatorAppMock(id, toolkit, input) },
}));
vi.mock("./ComposioAppSetup", () => ({ ComposioAppSetup: () => null }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const HUB = "https://hub.example";
const hub = { id: "hub-1", name: "Connect Hub", status: "active", enabled: true, healthStatus: "healthy",
  config: { sourceTemplateKey: "connecthub", url: `${HUB}/mcp/s/srv_1` } } as unknown as ToolConnection;
const github = AGGREGATOR_APP_CATALOG.find(app => app.slug === "github")!;

describe("AggregatorConnectDialog with Connect Hub", () => {
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
  const button = (label: string) => [...document.body.querySelectorAll("button")].find(b => b.textContent?.includes(label));
  async function render(connections: Record<string, ToolConnection[]>, onNavigate = vi.fn()) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(<QueryClientProvider client={client}>
        <AggregatorConnectDialog app={github} connections={connections} onClose={() => undefined} onNavigate={onNavigate} />
      </QueryClientProvider>);
    });
    return onNavigate;
  }

  it("offers Connect Hub as a provider choice next to Composio and Arcade", async () => {
    await render({});
    expect(button("Connect Hub")).toBeTruthy();
    expect(button("Composio")).toBeTruthy();
  });

  it("sends a person without a hub connection to Connect Hub setup for this app", async () => {
    const onNavigate = await render({});
    await act(async () => button("Connect Hub")!.click());
    expect(onNavigate).toHaveBeenCalledWith("/apps/connect?source=connecthub&targetToolkit=github");
  });

  it("starts the hub's connect link for the app and confirms it afterwards", async () => {
    setupAggregatorAppMock.mockResolvedValueOnce({ status: "authorization_required", authorizationUrl: `${HUB}/connect/ln_1?sig=x` });
    await render({ connecthub: [hub] });
    await act(async () => button("Connect Hub")!.click());
    await act(async () => button("Connect GitHub")!.click());
    expect(setupAggregatorAppMock).toHaveBeenCalledWith("hub-1", "github", { action: "start" });
    expect(document.body.querySelector(`a[href="${HUB}/connect/ln_1?sig=x"]`)?.textContent).toContain("Connect GitHub in Connect Hub");

    setupAggregatorAppMock.mockResolvedValueOnce({ status: "connected" });
    await act(async () => button("I’ve connected it")!.click());
    expect(setupAggregatorAppMock).toHaveBeenLastCalledWith("hub-1", "github", { action: "complete" });
    expect(document.body.textContent).toContain("GitHub is connected in Connect Hub");
  });

  it("resumes an unfinished hub connection in Paperclip instead of starting a link", async () => {
    const draft = { ...hub, status: "draft" } as unknown as ToolConnection;
    const onNavigate = await render({ connecthub: [draft] });
    await act(async () => button("Connect Hub")!.click());
    expect(button("Connect GitHub")).toBeUndefined();
    await act(async () => button("Finish setup")!.click());
    expect(onNavigate).toHaveBeenCalledWith("/apps/connect?source=connecthub&targetToolkit=github&resume=hub-1");
    expect(setupAggregatorAppMock).not.toHaveBeenCalled();
  });

  it("shows the hub's error instead of a link when the server does not expose the app", async () => {
    setupAggregatorAppMock.mockRejectedValueOnce(new Error("Toolkit is not on this MCP server"));
    await render({ connecthub: [hub] });
    await act(async () => button("Connect Hub")!.click());
    await act(async () => button("Connect GitHub")!.click());
    // A rejected mutation settles after the click's own act() tick.
    await vi.waitFor(() => expect(document.body.querySelector('[role="alert"]')?.textContent ?? "").toContain("Toolkit is not on this MCP server"));
    expect(document.body.querySelector(`a[href^="${HUB}/connect"]`)).toBeNull();
  });
});

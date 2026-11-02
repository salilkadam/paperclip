/**
 * Upload a file to Google Drive through the Google Workspace MCP server.
 *
 * The connector speaks just enough MCP (streamable HTTP, JSON-RPC) to call one
 * tool, `gw_create_file`, with the bytes it holds server-side. The model never
 * sees or relays the file. The folder is resolved from config by key, so an
 * agent can only file into folders the operator listed.
 */

export class DriveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DriveError";
  }
}

export interface DriveSettings {
  /** MCP endpoint, e.g. http://mcp-gworkspace-server.mcp.svc.cluster.local:8015/mcp */
  mcpUrl: string;
  tenantId: string;
  account: string;
  /** Folder key -> Drive folder id. Only these folders can be written. */
  folders: Record<string, string>;
  timeoutMs: number;
  /** Gateway key (sent as X-API-Key), resolved from a secret ref at call time. */
  apiKey?: unknown;
}

export interface DriveUploadResult {
  fileId: string;
  name: string;
  webViewLink: string;
  folderKey: string;
  folderId: string;
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** Pull the JSON-RPC message out of a JSON or SSE response body. */
function rpcMessage(body: string, contentType: string): Record<string, unknown> {
  if (contentType.includes("text/event-stream")) {
    const data = body
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .filter(Boolean);
    for (const chunk of data.reverse()) {
      try {
        const msg = JSON.parse(chunk);
        if (msg && typeof msg === "object" && ("result" in msg || "error" in msg)) return msg;
      } catch {
        /* keep looking */
      }
    }
    throw new DriveError("the Drive server sent an event stream with no result");
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new DriveError(`the Drive server sent a non-JSON reply: ${body.slice(0, 200)}`);
  }
}

async function rpc(
  fetchImpl: Fetch,
  settings: DriveSettings & { resolvedKey?: string },
  method: string,
  params: Record<string, unknown>,
  id: number,
  sessionId: string | null,
): Promise<{ message: Record<string, unknown>; sessionId: string | null }> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  if (settings.resolvedKey) headers["x-api-key"] = settings.resolvedKey;
  let response: Response;
  try {
    response = await fetchImpl(settings.mcpUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      signal: AbortSignal.timeout(settings.timeoutMs),
    });
  } catch (error) {
    throw new DriveError(`could not reach the Drive server at ${settings.mcpUrl}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const text = await response.text();
  if (!response.ok) {
    const hint = response.status === 401 || response.status === 403 ? " (check drive.apiKey)" : "";
    throw new DriveError(`the Drive server answered HTTP ${response.status} to ${method}${hint}: ${text.slice(0, 300)}`);
  }
  return { message: rpcMessage(text, response.headers.get("content-type") ?? ""), sessionId: response.headers.get("mcp-session-id") ?? sessionId };
}

/** Read the tool's own payload from an MCP tools/call result. */
function toolPayload(result: Record<string, unknown>): Record<string, unknown> {
  const structured = result.structuredContent;
  if (structured && typeof structured === "object") {
    const s = structured as Record<string, unknown>;
    // FastMCP wraps non-object returns as {result: ...}
    return s.result && typeof s.result === "object" && !("success" in s) ? (s.result as Record<string, unknown>) : s;
  }
  const content = Array.isArray(result.content) ? result.content : [];
  for (const item of content) {
    if (item && typeof item === "object" && (item as { type?: string }).type === "text") {
      try {
        return JSON.parse((item as { text: string }).text);
      } catch {
        return { success: false, error: (item as { text: string }).text };
      }
    }
  }
  return {};
}

/**
 * Upload bytes as a new file in one of the configured folders.
 * Throws DriveError on any failure, including a tool-level `success: false`.
 */
/** Prove the Drive server is reachable and accepts our credential, without writing anything. */
export async function preflightDrive(
  settings: DriveSettings & { resolvedKey?: string },
  fetchImpl: Fetch = globalThis.fetch,
): Promise<void> {
  const init = await rpc(
    fetchImpl,
    settings,
    "initialize",
    { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "paperclip-loc-agentmail", version: "0.2.0" } },
    1,
    null,
  );
  if (init.message.error) throw new DriveError(`the Drive server refused initialize: ${JSON.stringify(init.message.error).slice(0, 300)}`);
}

export async function uploadToDrive(
  settings: DriveSettings & { resolvedKey?: string },
  input: { folderKey: string; name: string; bytes: Uint8Array; mimeType: string },
  fetchImpl: Fetch = globalThis.fetch,
): Promise<DriveUploadResult> {
  const folderId = settings.folders[input.folderKey];
  if (!folderId) {
    throw new DriveError(`unknown Drive folder "${input.folderKey}". Configured folders: ${Object.keys(settings.folders).join(", ") || "(none)"}`);
  }
  const init = await rpc(
    fetchImpl,
    settings,
    "initialize",
    { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "paperclip-loc-agentmail", version: "0.2.0" } },
    1,
    null,
  );
  if (init.message.error) throw new DriveError(`the Drive server refused initialize: ${JSON.stringify(init.message.error).slice(0, 300)}`);

  const call = await rpc(
    fetchImpl,
    settings,
    "tools/call",
    {
      name: "gw_create_file",
      arguments: {
        tenant_id: settings.tenantId,
        account: settings.account,
        name: input.name,
        content: Buffer.from(input.bytes).toString("base64"),
        mime_type: input.mimeType,
        folder_id: folderId,
        content_is_base64: true,
      },
    },
    2,
    init.sessionId,
  );
  if (call.message.error) throw new DriveError(`the Drive upload failed: ${JSON.stringify(call.message.error).slice(0, 300)}`);
  const result = (call.message.result ?? {}) as Record<string, unknown>;
  const payload = toolPayload(result);
  if (result.isError === true || payload.success !== true) {
    throw new DriveError(`the Drive upload failed: ${String(payload.error ?? JSON.stringify(payload)).slice(0, 300)}`);
  }
  const data = (payload.data ?? {}) as Record<string, unknown>;
  if (typeof data.id !== "string" || !data.id) throw new DriveError("the Drive server reported success but returned no file id");
  return {
    fileId: data.id,
    name: typeof data.name === "string" ? data.name : input.name,
    webViewLink: typeof data.webViewLink === "string" ? data.webViewLink : `https://drive.google.com/file/d/${data.id}/view`,
    folderKey: input.folderKey,
    folderId,
  };
}

import type { toolConnections } from "@paperclipai/db";
import { unprocessable } from "../../../errors.js";

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value))
    return value as Record<string, unknown>;
  return {};
}

const MAX_CONNECTION_HEALTH_PROBES = 5;

/**
 * A board-configured deep health probe (`config.healthProbes`). The health
 * check calls this read-only tool through the agent dispatch path, so it
 * exercises upstream per-account tokens that `tools/list` never touches.
 */
export interface ToolConnectionHealthProbe {
  toolName: string;
  arguments: Record<string, unknown>;
  label: string;
  agentId: string | null;
  timeoutMs?: number;
}

export type ToolConnectionProbeRunner = (input: {
  companyId: string;
  connectionId: string;
  toolName: string;
  parameters: Record<string, unknown>;
  agentId: string | null;
  timeoutMs?: number;
}) => Promise<{ ok: true } | { ok: false; reasonCode: string; message: string }>;

export function readConnectionHealthProbes(config: unknown): ToolConnectionHealthProbe[] {
  const raw = asRecord(config).healthProbes;
  if (!Array.isArray(raw)) return [];
  const probes: ToolConnectionHealthProbe[] = [];
  for (const entry of raw) {
    const record = asRecord(entry);
    const toolName = typeof record.toolName === "string" ? record.toolName.trim() : "";
    if (!toolName) continue;
    const timeoutMs = typeof record.timeoutMs === "number" && Number.isFinite(record.timeoutMs)
      ? record.timeoutMs
      : undefined;
    probes.push({
      toolName,
      arguments: asRecord(record.arguments),
      label: typeof record.label === "string" && record.label.trim() ? record.label.trim() : toolName,
      agentId: typeof record.agentId === "string" && record.agentId.trim() ? record.agentId.trim() : null,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
    if (probes.length >= MAX_CONNECTION_HEALTH_PROBES) break;
  }
  return probes;
}

/**
 * Run the board-configured deep probes. A failure throws
 * `health_probe_failed`, so the connection health becomes `degraded` and the
 * board sees it in apps-needing-attention. A regular probe call also keeps
 * upstream refresh tokens in use, so idle tokens do not expire.
 */
export async function runConnectionHealthProbes(
  connection: typeof toolConnections.$inferSelect,
  toolProbe: ToolConnectionProbeRunner,
): Promise<number> {
  const probes = readConnectionHealthProbes(connection.config);
  const failures: Array<{ label: string; reasonCode: string; message: string }> = [];
  for (const probe of probes) {
    const result = await toolProbe({
      companyId: connection.companyId,
      connectionId: connection.id,
      toolName: probe.toolName,
      parameters: probe.arguments,
      agentId: probe.agentId,
      ...(probe.timeoutMs === undefined ? {} : { timeoutMs: probe.timeoutMs }),
    });
    if (!result.ok) failures.push({ label: probe.label, reasonCode: result.reasonCode, message: result.message });
  }
  if (failures.length > 0) {
    const needsConsent = failures.some((failure) => failure.reasonCode === "upstream_reauthorization_required");
    const summary = failures
      .map((failure) => `Health probe "${failure.label}" failed: ${failure.message}`)
      .join(" | ");
    throw unprocessable(
      `${failures.length} of ${probes.length} health probes failed. ${summary}${
        needsConsent ? " An upstream account needs re-consent. Reconnect it, then run the health check again." : ""
      }`,
      {
        code: "health_probe_failed",
        probes: failures.map(({ label, reasonCode }) => ({ label, reasonCode })),
      },
    );
  }
  return probes.length;
}

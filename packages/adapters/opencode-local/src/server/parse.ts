import { asString, parseJson, parseObject } from "@paperclipai/adapter-utils/server-utils";

function errorText(value: unknown): string {
  if (typeof value === "string") return value;
  const rec = parseObject(value);
  const message = asString(rec.message, "").trim();
  if (message) return message;
  const data = parseObject(rec.data);
  const nestedMessage = asString(data.message, "").trim();
  if (nestedMessage) return nestedMessage;
  const name = asString(rec.name, "").trim();
  if (name) return name;
  const code = asString(rec.code, "").trim();
  if (code) return code;
  try {
    return JSON.stringify(rec);
  } catch {
    return "";
  }
}

export function parseOpenCodeJsonl(stdout: string) {
  return createOpenCodeJsonlParser()(stdout);
}

/** Consume complete JSONL records once, retaining protocol accounting state. */
export function createOpenCodeJsonlParser() {
  let sessionId: string | null = null;
  // Assistant text grouped by OpenCode message. A message whose text is
  // followed by a tool call is working narration ("I need to check …"); the
  // run's answer is the latest message whose text ends it.
  const groups = new Map<string, { texts: string[]; partIds: string[]; toolAfterText: boolean; lastSeq: number }>();
  const transcript: string[] = [];
  let seq = 0;
  const errors: string[] = [];
  const toolErrors: string[] = [];
  const usage = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
  };
  let costUsd: number | null = null;
  let missingCost = false;
  let usageReported = false;
  let missingUsage = false;

  return (stdout: string) => {
    for (const rawLine of stdout.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;

      const event = parseJson(line);
      if (!event) continue;

      const currentSessionId = asString(event.sessionID, "").trim();
      if (currentSessionId) sessionId = currentSessionId;

      const type = asString(event.type, "");

      if (type === "text") {
        const part = parseObject(event.part);
        const text = asString(part.text, "").trim();
        if (text) {
          transcript.push(text);
          const id = asString(part.messageID, "");
          const group = groups.get(id) ?? { texts: [], partIds: [], toolAfterText: false, lastSeq: 0 };
          // A re-sent part (same part id) replaces its earlier text.
          const partId = asString(part.id, "");
          const existing = partId ? group.partIds.indexOf(partId) : -1;
          if (existing >= 0) group.texts[existing] = text;
          else { group.texts.push(text); group.partIds.push(partId); }
          group.toolAfterText = false;
          group.lastSeq = ++seq;
          groups.set(id, group);
        }
        continue;
      }

      if (type === "step_finish") {
        const part = parseObject(event.part);
        const tokens = parseObject(part.tokens);
        const cache = parseObject(tokens.cache);
        const counts = [tokens.input, tokens.output, cache.read === undefined ? 0 : cache.read, cache.write === undefined ? 0 : cache.write, tokens.reasoning === undefined ? 0 : tokens.reasoning];
        if (counts.every(value => typeof value === "number" && Number.isSafeInteger(value) && value >= 0)) {
          const [input, output, cached, written, reasoning] = counts as number[];
          const next = { inputTokens: usage.inputTokens + input + written,
            outputTokens: usage.outputTokens + output + reasoning, cachedInputTokens: usage.cachedInputTokens + cached };
          if (Object.values(next).every(Number.isSafeInteger)) { Object.assign(usage, next); usageReported = true; }
          else missingUsage = true;
        } else missingUsage = true;
        if (typeof part.cost === "number" && Number.isFinite(part.cost) && part.cost >= 0) costUsd = (costUsd ?? 0) + part.cost;
        else missingCost = true;
        continue;
      }

      if (type === "tool_use") {
        const part = parseObject(event.part);
        const group = groups.get(asString(part.messageID, ""));
        if (group?.texts.length) group.toolAfterText = true;
        const state = parseObject(part.state);
        if (asString(state.status, "") === "error") {
          const text = asString(state.error, "").trim();
          if (text) toolErrors.push(text);
        }
        continue;
      }

      if (type === "error") {
        const text = errorText(event.error ?? event.message).trim();
        if (text) errors.push(text);
        continue;
      }
    }

    return {
      sessionId,
      // A run that ends on a tool call (timeout, abort, error) has no final
      // answer; keep the whole transcript so the run still reports something.
      summary: finalAnswer(groups) || transcript.join("\n\n").trim(),
      usage: { ...usage },
      usageReported,
      usageComplete: usageReported && !missingUsage,
      costUsd: missingCost ? null : costUsd,
      errorMessage: errors.length > 0 ? errors.join("\n") : null,
      toolErrors,
    };
  };
}

function finalAnswer(groups: Map<string, { texts: string[]; partIds: string[]; toolAfterText: boolean; lastSeq: number }>): string {
  let best: { texts: string[]; lastSeq: number } | null = null;
  for (const group of groups.values()) {
    if (!group.toolAfterText && (!best || group.lastSeq > best.lastSeq)) best = group;
  }
  return best ? best.texts.join("\n\n").trim() : "";
}

export function isOpenCodeUnknownSessionError(stdout: string, stderr: string): boolean {
  const haystack = `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");

  return /unknown\s+session|session\b.*\bnot\s+found|resource\s+not\s+found:.*[\\/]session[\\/].*\.json|notfounderror|no session/i.test(
    haystack,
  );
}

#!/usr/bin/env node
/**
 * Rule for every Reliora agent: a chat (Slack) question is answered with a
 * COMMENT on its task, never only in the run's final response.
 *
 * Why: the Slack bridge relays task comments back to the thread. On 2026-10-27
 * (REL-3145) and 2026-10-29 (REL-3210) the CMO researched the board's Slack
 * question, wrote a complete answer as its final response (taking the
 * paperclip skill's "server-verified external chat" shortcut, whose marker was
 * absent), and exited. The answer stayed in the run log, Slack showed only
 * "CMO has no final response to show yet", and both tasks were left
 * in_progress with no wake path.
 *
 * Upserts a marker-delimited section into each agent's entry AGENTS.md via the
 * instructions-bundle API. Re-running replaces it in place. The roster is read
 * live (every non-terminated agent with an instructions bundle), so new hires
 * are covered on the next run.
 *
 *   --check   change nothing; exit 1 if any agent lacks the current section
 *
 * Usage (inside the app pod; token is the FIRST stdin line):
 *   printf '%s\n' "$TOKEN" | cat - deploy/scripts/agents-chat-reply-rule.mjs | \
 *     kubectl -n bionicorg exec -i deploy/bionic-org -c bionic -- \
 *     sh -c 'read T; export BIONIC_BOARD_TOKEN=$T; exec node - [--check]'
 */

const API = process.env.BIONIC_API || "http://localhost:3100/api";
const COMPANY = "62d63984-df6c-49be-981c-1273f68a451c"; // Reliora Inc
const CHECK = process.argv.includes("--check");
const BEGIN = "<!-- BEGIN bionic-org:chat-replies -->";
const END = "<!-- END bionic-org:chat-replies -->";

const SECTION = [
  BEGIN,
  "## Answering chat and Slack questions (mandatory)",
  "",
  "A task that came from Slack or another chat channel is answered with a",
  "**comment on that task**. The comment is the only thing relayed back to the",
  "person who asked. Text that exists only in your final response is never",
  "delivered: they see \"no final response to show yet\" and nothing else.",
  "",
  "- Post the full answer as a task comment, in plain language, before you exit.",
  "- This applies even where the `paperclip` skill describes a \"server-verified",
  "  external chat\" shortcut. In this company, always post the comment.",
  "- Then set the task `done`. If you need a decision from the board, save the",
  "  question as an interaction and set `in_review` instead. Never leave a chat",
  "  task `in_progress` with nothing scheduled to wake you.",
  "- If the work will take longer than this run, post a short comment saying what",
  "  you are doing and when the answer will come, then follow the normal",
  "  heartbeat rules.",
  END,
].join("\n");

async function api(path, init = {}) {
  const res = await fetch(API + path, {
    ...init,
    headers: {
      Authorization: "Bearer " + process.env.BIONIC_BOARD_TOKEN,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  const body = await res.text();
  let json = null;
  try { json = JSON.parse(body); } catch {}
  if (!res.ok) throw new Error(path + " -> " + res.status + " " + body.slice(0, 200));
  return json;
}

(async () => {
  if (!process.env.BIONIC_BOARD_TOKEN) throw new Error("no board token (set BIONIC_BOARD_TOKEN)");
  const agents = (await api(`/companies/${COMPANY}/agents`))
    .filter((a) => a.status !== "terminated" && a.adapterType !== "hermes_gateway");
  if (agents.length === 0) throw new Error("roster is empty; refusing to report success");
  const report = [];
  let missing = 0;
  for (const a of agents) {
    const q = encodeURIComponent("AGENTS.md");
    const cur = await api(`/agents/${a.id}/instructions-bundle/file?path=${q}`);
    const content = cur.content ?? "";
    const next = content.includes(BEGIN)
      ? content.replace(new RegExp(`${BEGIN}[\\s\\S]*?${END}`), SECTION)
      : content.trimEnd() + "\n\n" + SECTION + "\n";
    if (next === content) { report.push({ agent: a.name, result: "current" }); continue; }
    if (CHECK) { missing++; report.push({ agent: a.name, result: "MISSING_OR_STALE" }); continue; }
    await api(`/agents/${a.id}/instructions-bundle/file`, {
      method: "PUT",
      body: JSON.stringify({ path: "AGENTS.md", content: next, baseHash: cur.contentHash ?? null }),
    });
    const after = await api(`/agents/${a.id}/instructions-bundle/file?path=${q}`);
    if (!(after.content ?? "").includes(SECTION)) throw new Error(`${a.name}: write not visible on re-read`);
    report.push({ agent: a.name, result: "updated" });
  }
  console.log(JSON.stringify(report, null, 1));
  if (CHECK && missing) { console.error(`CHECK FAILED: ${missing} agent(s) lack the chat-replies rule`); process.exit(1); }
})().catch((e) => { console.error("ERR:", e.message); process.exit(2); });

#!/usr/bin/env node
/**
 * Retires the per-agent "chat replies" block (bionic-org:chat-replies) from
 * every agent's AGENTS.md, in every company.
 *
 * History: on 2026-10-29/30 Reliora's CMO answered Slack questions that never
 * reached Slack. The block was a stopgap that told each agent to answer with a
 * task comment. The causes are now fixed in the platform, so every company and
 * every new agent inherits the behaviour without per-agent instructions:
 *   - opencode_local reports only the final answer message as the run's
 *     response (packages/adapters/opencode-local/src/server/parse.ts); joined
 *     narration made Paperclip discard it.
 *   - Every chat turn carries "Replying in this chat" guidance
 *     (server/src/services/chat-reply-guidance.ts): answer once in the final
 *     response, no narration, summary-first cards, keep a waiting task
 *     in_review.
 *   - The paperclip and board-plain-language skills carry the board rules.
 * The block's "post the answer as a comment" rule now conflicts with the
 * platform's final-response delivery (it causes duplicate replies), so it is
 * removed, not refreshed.
 *
 *   --check   change nothing; exit 1 if any agent still has the block
 *
 * Usage (inside the app pod; token is the FIRST stdin line):
 *   printf '%s\n' "$TOKEN" | cat - deploy/scripts/agents-retire-chat-reply-block.mjs | \
 *     kubectl -n bionicorg exec -i deploy/bionic-org -c bionic -- \
 *     sh -c 'read T; export BIONIC_BOARD_TOKEN=$T; exec node --input-type=module - [--check]'
 */

const API = process.env.BIONIC_API || "http://localhost:3100/api";
const CHECK = process.argv.includes("--check");
const BEGIN = "<!-- BEGIN bionic-org:chat-replies -->";
const END = "<!-- END bionic-org:chat-replies -->";

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
  const companies = await api("/companies");
  if (!Array.isArray(companies) || companies.length === 0) throw new Error("no companies visible; refusing to report success");
  const report = [];
  let remaining = 0, failed = 0, checked = 0;
  for (const company of companies) {
    const agents = (await api(`/companies/${company.id}/agents`))
      .filter((a) => a.status !== "terminated" && a.adapterType !== "hermes_gateway");
    for (const a of agents) {
      const label = `${company.name} / ${a.name}`;
      try {
        const q = encodeURIComponent("AGENTS.md");
        let cur;
        try {
          cur = await api(`/agents/${a.id}/instructions-bundle/file?path=${q}`);
        } catch (e) {
          if (/-> 404 /.test(e.message)) { report.push({ agent: label, result: "no-bundle" }); continue; }
          throw e;
        }
        checked++;
        const content = cur.content ?? "";
        const b = content.split(BEGIN).length - 1, e = content.split(END).length - 1;
        if (b === 0 && e === 0) { report.push({ agent: label, result: "clean" }); continue; }
        if (b !== e || b > 1 || content.indexOf(END) < content.indexOf(BEGIN)) {
          throw new Error(`malformed chat-replies markers (BEGIN x${b}, END x${e}); fix by hand`);
        }
        if (CHECK) { remaining++; report.push({ agent: label, result: "HAS_BLOCK" }); continue; }
        const next = content.replace(new RegExp(`\\n*${BEGIN}[\\s\\S]*?${END}\\n?`), "\n").trimEnd() + "\n";
        await api(`/agents/${a.id}/instructions-bundle/file`, {
          method: "PUT",
          body: JSON.stringify({ path: "AGENTS.md", content: next, baseHash: cur.contentHash ?? null }),
        });
        const after = await api(`/agents/${a.id}/instructions-bundle/file?path=${q}`);
        if ((after.content ?? "").includes(BEGIN)) throw new Error("block still present on re-read");
        report.push({ agent: label, result: "removed" });
      } catch (err) {
        failed++;
        report.push({ agent: label, result: "ERROR", error: err.message });
      }
    }
  }
  console.log(JSON.stringify(report, null, 1));
  if (checked === 0) { console.error("checked no agent bundles; refusing to report success"); process.exit(2); }
  if (failed) { console.error(`FAILED: ${failed} agent(s) errored; see report`); process.exit(2); }
  if (CHECK && remaining) { console.error(`CHECK FAILED: ${remaining} agent(s) still carry the retired block`); process.exit(1); }
})().catch((e) => { console.error("ERR:", e.message); process.exit(2); });

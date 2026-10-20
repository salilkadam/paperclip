#!/usr/bin/env node
// Gate for the SRE harness approval watcher.
//
// deploy/helm/sre-harness/templates/approvals-configmap.yaml embeds scan.js,
// the no-LLM scanner that decides whether an operator has approved or declined
// a fix PR. It is machine-critical logic that a `helm lint` pass cannot check:
// a wrong decision merges and deploys code, and a decision that keeps matching
// re-runs a full merge-build-deploy every cron tick.
//
// This renders the chart, extracts the real scan.js, and drives it through
// scenarios against a stubbed GitHub API. Skips (exit 0) when helm is absent,
// so it is safe on a machine without a Helm binary.
//
// Run: pnpm test:sre-harness-scan
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const chartDir = path.join(repoRoot, "deploy/helm/sre-harness");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-scan-"));

function sh(cmd, args) {
  return spawnSync(cmd, args, { encoding: "utf8", cwd: repoRoot });
}

const helmCheck = sh("helm", ["version", "--short"]);
if (helmCheck.status !== 0) {
  console.log("[sre-harness-scan] SKIPPED: helm is not installed on this machine");
  process.exit(0);
}

const rendered = sh("helm", ["template", "sre-harness", chartDir]);
if (rendered.status !== 0) {
  console.error("[sre-harness-scan] FAILED to render the chart:\n" + rendered.stderr);
  process.exit(1);
}

// Pull the scan.js block out of the rendered ConfigMap. Block scalars are
// indented two spaces past their key, so dedent by exactly that.
function extractScript(yamlText, key) {
  const lines = yamlText.split("\n");
  let start = -1;
  let keyIndent = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const m = new RegExp(`^(\\s*)${key}: \\|$`).exec(lines[i]);
    if (m) {
      start = i + 1;
      keyIndent = m[1].length;
      break;
    }
  }
  if (start === -1) throw new Error(`rendered chart has no "${key}" block scalar`);
  const bodyIndent = keyIndent + 2;
  const out = [];
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === "") {
      out.push("");
      continue;
    }
    const indent = line.length - line.trimStart().length;
    if (indent < bodyIndent) break;
    out.push(line.slice(bodyIndent));
  }
  return out.join("\n") + "\n";
}

const scanPath = path.join(tmp, "scan.js");
fs.writeFileSync(scanPath, extractScript(rendered.stdout, "scan\\.js"));

const stubPath = path.join(tmp, "fetch-stub.cjs");
fs.writeFileSync(
  stubPath,
  `const S = JSON.parse(process.env.STUB_DATA);
const base = process.env.GITHUB_API;
global.fetch = async (url) => {
  const u = String(url).replace(base, "");
  const json = (data) => ({ ok: true, status: 200, json: async () => data });
  if (u.startsWith("/repos/o/r/labels/")) return json({ name: "dsh-fix" });
  if (u.startsWith("/repos/o/r/issues?")) return json(S.issues);
  const pm = /^\\/repos\\/o\\/r\\/pulls\\/(\\d+)$/.exec(u);
  if (pm) return json(S.pulls[pm[1]]);
  const rm = /^\\/repos\\/o\\/r\\/pulls\\/(\\d+)\\/reviews$/.exec(u);
  if (rm) return json(S.reviews[rm[1]] || []);
  const cm = /^\\/repos\\/o\\/r\\/issues\\/(\\d+)\\/comments/.exec(u);
  if (cm) return json(S.comments[cm[1]] || []);
  throw new Error("unstubbed url: " + u);
};
`,
);

const OP = { login: "salilkadam" };
const OTHER = { login: "someone-else" };
const at = (h) => `2026-10-19T${h}:00Z`;
const cm = (h, body, user = OP) => ({ user, created_at: at(h), body });
const review = (h, state, user = OP) => ({ user, submitted_at: at(h), state });
const OPEN_PR = { 51: { state: "open", title: "t", head: { sha: "abc123" }, mergeable: true } };
const ONE_PR = [{ number: 51, pull_request: {} }];
const data = (pulls, reviews, comments) =>
  JSON.stringify({ issues: ONE_PR, pulls, reviews, comments });

const cases = [
  ["an operator approve comment is an approve", data(OPEN_PR, {}, { 51: [cm("01:00", "deploy: approve")] }), "approve"],
  ["an operator APPROVED review is an approve", data(OPEN_PR, { 51: [review("01:00", "APPROVED")] }, {}), "approve"],
  ["a recorded action cancels the re-run", data(OPEN_PR, {}, { 51: [cm("01:00", "deploy: approve"), cm("01:20", "dsh-action: failed build blew up")] }), null],
  ["a marker at the same second still cancels", data(OPEN_PR, {}, { 51: [cm("01:00", "deploy: approve"), cm("01:00", "dsh-action: merged abc")] }), null],
  ["a fresh approve after a failure re-arms it", data(OPEN_PR, {}, { 51: [cm("01:00", "deploy: approve"), cm("01:20", "dsh-action: failed boom"), cm("02:00", "deploy: approve")] }), "approve"],
  ["the newest decision wins: decline then approve", data(OPEN_PR, {}, { 51: [cm("01:00", "deploy: decline nope"), cm("03:00", "deploy: approve")] }), "approve"],
  ["the newest decision wins: approve then decline", data(OPEN_PR, {}, { 51: [cm("01:00", "deploy: approve"), cm("03:00", "deploy: decline nope")] }), "decline"],
  ["a tie in the same second keeps decline", data(OPEN_PR, {}, { 51: [cm("01:00", "deploy: approve"), cm("01:00", "deploy: decline")] }), "decline"],
  ["a non-operator comment decides nothing", data(OPEN_PR, {}, { 51: [cm("01:00", "deploy: approve", OTHER)] }), null],
  ["a closed PR decides nothing", data({ 51: { state: "closed", title: "t", head: { sha: "abc" } } }, {}, { 51: [cm("01:00", "deploy: approve")] }), null],
];

let failed = 0;
for (const [name, stub, want] of cases) {
  const run = spawnSync("node", ["-r", stubPath, scanPath], {
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_API: "https://api.example",
      GH_REPO: "o/r",
      GH_LABEL: "dsh-fix",
      GH_APPROVERS: "salilkadam",
      GIT_PAT: "x",
      STUB_DATA: stub,
    },
  });
  if (run.status !== 0) {
    console.log(`FAIL  ${name} (scan.js exited ${run.status}: ${(run.stderr || "").trim()})`);
    failed += 1;
    continue;
  }
  let got;
  try {
    got = JSON.parse(run.stdout.trim()).decision;
  } catch {
    console.log(`FAIL  ${name} (scan.js printed non-JSON: ${run.stdout.trim()})`);
    failed += 1;
    continue;
  }
  if (got !== want) {
    console.log(`FAIL  ${name} (want ${JSON.stringify(want)}, got ${JSON.stringify(got)})`);
    failed += 1;
    continue;
  }
  console.log(`ok    ${name}`);
}

fs.rmSync(tmp, { recursive: true, force: true });
if (failed) {
  console.error(`\n[sre-harness-scan] ${failed}/${cases.length} scenario(s) failed`);
  process.exit(1);
}
console.log(`\n[sre-harness-scan] all ${cases.length} approval-scanner scenarios pass`);

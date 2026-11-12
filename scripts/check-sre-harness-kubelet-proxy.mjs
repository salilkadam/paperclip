#!/usr/bin/env node
// Gate for the kubelet-proxy black-hole forensics in the SRE harness.
//
// deploy/helm/sre-harness/templates/_helpers.tpl embeds the runner shell:
// probe_log_readability (which node am I on; can my own logs be read back)
// and record_run (the durable line written to the sre-harness-run-log
// ConfigMap). Since 2026-11-09 one cluster node answers the apiserver->
// kubelet log proxy with 502 while serving pods normally, so `kubectl logs`
// - including a sweep reading its OWN job log - dies silently on it, and the
// run-log record is the only evidence that survives. This gate pins:
//
//   1. probe_log_readability's classification against a stubbed API server:
//      200 -> "yes", 502 -> "no" with the node named, 401/403 -> unjudged,
//      a dial-level hang -> unjudged (never a fabricated verdict), and the
//      pod-object read naming the node even while its log path is black;
//   2. set -u safety of the whole record path under DASH: a bare "$VAR" on
//      the env-prefix line aborts EVERY record with "parameter not set",
//      silently destroying the forensics this file exists to protect;
//   3. the record schema: node/logsReadable present, null (never probed)
//      distinct from "no", and the 3000-char excerpt (500 cut reports off
//      before their verdict line - 2026-11-12 run-log, 17:30 record).
//
// The tested bytes come from the rendered chart; only two literals are
// redirected (the API host, the serviceaccount dir) and the gate asserts
// each redirect applied, so a shape change in _helpers.tpl fails loudly
// instead of testing a stub. Skips (exit 0) when helm/dash/openssl are
// absent. Drives stubs only - never a cluster.
// Run: pnpm test:sre-harness-kubelet-proxy
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const chartDir = path.join(repoRoot, "deploy/helm/sre-harness");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-kubeproxy-"));

function sh(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: "utf8", cwd: repoRoot, timeout: 60000, ...opts });
}

for (const [bin, why] of [
  ["helm", "helm is not installed"],
  ["dash", "dash is not installed (POSIX shell semantics are the subject)"],
]) {
  const r = sh(bin, bin === "helm" ? ["version", "--short"] : ["-c", "true"]);
  if (r.status !== 0) {
    console.log(`[sre-harness-kubelet-proxy] SKIPPED: ${why}`);
    process.exit(0);
  }
}

const rendered = sh("helm", ["template", "sre-harness", chartDir]);
if (rendered.status !== 0) {
  console.error("[sre-harness-kubelet-proxy] FAILED to render the chart:\n" + rendered.stderr);
  process.exit(1);
}

// Pull the monitor run.sh - it carries the whole expansion of
// sre-harness.runHeadless - out of the rendered ConfigMap block scalar;
// same dedent trick as check-sre-harness-scan.mjs.
function extractBlock(yamlText, key) {
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

const runSh = extractBlock(rendered.stdout, "run\\.sh");
for (const needle of ["probe_log_readability() {", "record_run() {", "RUN_NODE=", "RUN_LOG_READABLE="]) {
  if (!runSh.includes(needle)) {
    console.error(`[sre-harness-kubelet-proxy] FAILED: rendered runner lost "${needle}"`);
    process.exit(1);
  }
}

// Each helper function in the rendered runner closes at a "}" on column 0.
function sliceFn(src, name) {
  const start = src.indexOf(name + "() {");
  if (start === -1) throw new Error(`runner does not define ${name}()`);
  const end = src.indexOf("\n}\n", start);
  if (end === -1) throw new Error(`unterminated ${name}()`);
  return src.slice(start, end + 3);
}

function redirect(src, from, to, label) {
  const out = src.split(from).join(to);
  if (out === src) throw new Error(`redirect "${label}" did not apply - _helpers.tpl changed shape`);
  return out;
}

const saDir = path.join(tmp, "sa");
fs.mkdirSync(saDir, { recursive: true });
fs.writeFileSync(path.join(saDir, "namespace"), "testns\n");
fs.writeFileSync(path.join(saDir, "token"), "stub-token\n");
const stubKey = path.join(tmp, "key.pem");
const stubCert = path.join(tmp, "cert.pem");
// Node's TLS client matches the peer against the SAN list; a CN-only cert is
// rejected ("IP: 127.0.0.1 is not in the cert's list") the moment the record
// path verifies it, and the failure surfaces only as an opaque "get http 0".
// The stub cert must carry an IP SAN for exactly what the harness dials.
sh("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-keyout", stubKey, "-out", stubCert, "-days", "1", "-nodes", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"]);
if (!fs.existsSync(stubCert)) {
  console.log("[sre-harness-kubelet-proxy] SKIPPED: openssl unavailable for the stub TLS cert");
  process.exit(0);
}
fs.copyFileSync(stubCert, path.join(saDir, "ca.crt"));

// Redirects must be applied to the SOURCE BEFORE the single-quote escaping
// below, because the escaping rewrites the literal text we search for.
let probe = sliceFn(runSh, "probe_log_readability");
let recorder = sliceFn(runSh, "record_run");
for (const fn of ["probe", "recorder"]) {
  let src = fn === "probe" ? probe : recorder;
  src = redirect(src, '"kubernetes.default.svc"', "process.env.STUB_API_HOST", "api host");
  // Node's https.request takes host and port as SEPARATE options; the chart
  // code sets no port (443 is correct for kubernetes.default.svc). The stub
  // listens on a high port, so the gate must inject a port too -- on the same
  // options object, before `ca,`.
  src = redirect(src, "process.env.STUB_API_HOST,", "process.env.STUB_API_HOST, port: Number(process.env.STUB_API_PORT),", "api port");
  src = redirect(src, '"/var/run/secrets/kubernetes.io/serviceaccount/"', "process.env.SA_DIR + \"/\"", "serviceaccount dir");
  if (fn === "probe") probe = src; else recorder = src;
}

// The node -e body is embedded as a single-quoted JS string: opener
// `node -e '` and a closer that is a quote followed by the shell redirection
// (`' 2>/dev/null` for probe, `' 2>&1` for record). Both functions keep every
// other shell quote (the sed/printf lines) OUTSIDE the JS string, so scanning
// for the closer after the opener finds the JS boundary exactly -- and if the
// shape ever changes, the scan misses and this throws instead of silently
// testing unredirected bytes. The chart JS body is apostrophe-free by design
// (one apostrophe would close the shell string mid-flight -- the exact bug
// this file exists to catch), so the redirected source re-injects verbatim
// between the same quotes with no escaping.
function requote(fnSrc) {
  const pre = "node -e '";
  const aIdx = fnSrc.indexOf(pre);
  if (aIdx === -1) throw new Error("no node -e opener");
  const jsStart = aIdx + pre.length;
  const cRel = fnSrc.slice(jsStart).search(/'\s+2>/);
  if (cRel === -1) throw new Error("no node -e closer after opener");
  const cIdx = jsStart + cRel;
  return fnSrc.slice(0, aIdx) + "node -e " + fnSrc.slice(aIdx + pre.length - 1, cIdx + 1) + fnSrc.slice(cIdx + 1);
}
const probeBody = requote(probe);
const recBody = requote(recorder);

const sessionLog = path.join(tmp, "session.jsonl");
fs.writeFileSync(sessionLog, '{"type":"final","text":"stub"}\n');
const harnessPath = path.join(tmp, "harness.sh");
fs.writeFileSync(
  harnessPath,
  [
    "#!/bin/sh",
    "set -eu",
    "post_to_slack() { :; }",
    probeBody,
    recBody,
    "DSH_PROFILE=unittest",
    `DSH_LOG=${JSON.stringify(sessionLog)}`,
    "DSH_STARTED_AT=$(date +%s)",
    "DSH_RC=0",
    // Pin HOSTNAME: the pod name the stub is keyed on. The dash image bakes
    // an image hostname into ENV, so "${HOSTNAME:-stub}" would never fall
    // back and every pod-object read would target a pod the stub does not
    // know. Production takes the real pod name from the same ENV.
    "HOSTNAME=stub-pod-xyz",
    // ENTRY runs in THIS shell: functions are not exported, so a child shell
    // would answer "command not found". Quotes inside the entry survive one
    // pass (the JS in each entry line is already inside the functions, not
    // the entry itself; entries stay quote-light by construction).
    'if [ -n "${ENTRY:-}" ]; then eval "$ENTRY"; fi',
    "",
  ].join("\n"),
);

// The stub API server: rules per scenario, and every PATCH/POST body is
// dumped to REC_OUT (the record content is asserted from what the record
// writer actually tried to persist).
const stubPath = path.join(tmp, "api-stub.mjs");
fs.writeFileSync(
  stubPath,
  `import https from "node:https";
import fs from "node:fs";
const rules = JSON.parse(process.env.STUB_RULES);
const srv = https.createServer(
  { key: fs.readFileSync(process.env.STUB_KEY), cert: fs.readFileSync(process.env.STUB_CERT) },
  (req, res) => {
    let d = "";
    req.on("data", (x) => { d += x; });
    req.on("end", () => {
      for (const r of rules) {
        if (!req.url.startsWith(r.prefix)) continue;
        if (r.hang) return; // black hole: accept, never answer
        if (r.pod) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({
            kind: "Pod", metadata: { name: "stub-pod-xyz" },
            spec: { nodeName: r.pod, containers: [{ name: "dsh" }] },
          }));
          return;
        }
        res.writeHead(r.status, { "content-type": "text/plain" });
        res.end(r.body || "stub");
        return;
      }
      if ((req.method === "PATCH" || req.method === "POST") && process.env.REC_OUT) {
        fs.writeFileSync(process.env.REC_OUT, d);
        res.writeHead(200); res.end("{}"); return;
      }
      res.writeHead(404); res.end("unstubbed: " + req.method + " " + req.url);
    });
  },
);
srv.listen(Number(process.env.STUB_PORT), "127.0.0.1");
`,
);

const podPath = "/api/v1/namespaces/testns/pods/stub-pod-xyz";
const LONG_VERDICT = "PAPERCLIP HEALTH: WARN root cause far beyond the old five-hundred-char budget " + "x".repeat(2600);

const cases = [
  {
    name: "502 log proxy -> record names node1 and says unreadable",
    rules: [
      { prefix: podPath + "/log", status: 502, body: "502 Bad Gateway" },
      { prefix: podPath, pod: "node1" },
    ],
    entry: "probe_log_readability\nrecord_run 0 \"$LONG_VERDICT_TEXT\" running",
    env: { LONG_VERDICT_TEXT: LONG_VERDICT },
    expect: { node: "node1", logsReadable: "no" },
    expectExcerpt: true,
  },
  {
    name: "readable logs -> yes",
    rules: [
      { prefix: podPath + "/log", status: 200, body: "one line" },
      { prefix: podPath, pod: "node2" },
    ],
    entry: "probe_log_readability\nrecord_run 0 \"fine\" running",
    expect: { node: "node2", logsReadable: "yes" },
  },
  {
    name: "403 log read stays unjudged, never accuses the node",
    rules: [
      { prefix: podPath + "/log", status: 403, body: "Forbidden" },
      { prefix: podPath, pod: "node3" },
    ],
    entry: "probe_log_readability\nrecord_run 0 \"fine\" running",
    expect: { node: "node3", logsReadable: null },
  },
  {
    name: "dial-level hang stays unjudged (no fabricated verdict)",
    rules: [
      { prefix: podPath + "/log", hang: true },
      { prefix: podPath, pod: "node9" },
    ],
    entry: "probe_log_readability\nrecord_run 0 \"fine\" running",
    expect: { node: "node9", logsReadable: null },
  },
  {
    name: "no probe ran -> fields present and null, record still written",
    rules: [{ prefix: podPath, pod: "node5" }],
    entry: "record_run 0 \"no probe here\" running",
    expect: { node: null, logsReadable: null },
  },
];

let failures = 0;
for (const [i, c] of cases.entries()) {
  const stubPort = 18100 + i;
  const recOut = path.join(tmp, "rec-" + i + ".json");
  if (fs.existsSync(recOut)) fs.rmSync(recOut);
  const stub = spawn(process.execPath, [stubPath], {
    env: {
      ...process.env,
      STUB_PORT: String(stubPort),
      STUB_KEY: stubKey,
      STUB_CERT: stubCert,
      STUB_RULES: JSON.stringify(c.rules),
      REC_OUT: recOut,
    },
    stdio: "ignore",
  });
  await new Promise((r) => setTimeout(r, 400));
  const rr = sh("dash", [harnessPath], {
    env: {
      ...process.env,
      ...Object.fromEntries(Object.entries(c.env || {}).map(([k, v]) => [k, v])),
      ENTRY: c.entry,
      STUB_API_HOST: "127.0.0.1",
      STUB_API_PORT: String(stubPort),
      SA_DIR: saDir,
    },
    timeout: 40000,
  });
  stub.kill("SIGKILL");

  const problems = [];
  if (rr.status !== 0) problems.push(`dash exit ${rr.status}: ${(rr.stderr || "").slice(0, 300)}`);
  let parsed = null;
  if (fs.existsSync(recOut)) {
    try {
      const patch = JSON.parse(fs.readFileSync(recOut, "utf8"));
      parsed = JSON.parse(String(patch.data.runs).trim().split("\n")[0]);
    } catch (e) {
      problems.push("run-log PATCH body did not parse: " + e.message);
    }
  } else {
    problems.push("no run-log record reached the API stub");
  }
  if (parsed) {
    if (!("node" in parsed) || !("logsReadable" in parsed)) problems.push("record lost the node/logsReadable fields");
    if (parsed.node !== c.expect.node) problems.push(`node: got ${JSON.stringify(parsed.node)}, want ${JSON.stringify(c.expect.node)}`);
    if (parsed.logsReadable !== c.expect.logsReadable) problems.push(`logsReadable: got ${JSON.stringify(parsed.logsReadable)}, want ${JSON.stringify(c.expect.logsReadable)}`);
    if (c.expectExcerpt) {
      const ex = String(parsed.excerpt || "");
      if (ex.length <= 500) problems.push(`excerpt budget regressed to ${ex.length} (verdict evidence would be cut)`);
      if (ex.length > 3000) problems.push(`excerpt budget exceeded 3000: ${ex.length}`);
      if (!ex.startsWith("PAPERCLIP HEALTH:")) problems.push("excerpt lost its leading report line");
    }
  }
  if (problems.length) {
    failures += 1;
    console.error(`  ✗ ${c.name}\n    ${problems.join("\n    ")}`);
  } else {
    console.log(`  ✓ ${c.name}`);
  }
}

if (failures) {
  console.error(`[sre-harness-kubelet-proxy] FAILED (${failures} of ${cases.length})`);
  process.exit(1);
}
console.log(`[sre-harness-kubelet-proxy] OK (${cases.length} cases)`);

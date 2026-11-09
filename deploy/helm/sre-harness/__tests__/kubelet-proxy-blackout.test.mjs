import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Guards for the 2026-11-09 kubelet-proxy black hole: one node answered 502
// to every apiserver->kubelet proxy read (logs/exec/port-forward) while still
// scheduling pods normally, silently destroying the harness's documented
// `kubectl logs job/...` forensic path. These tests pin the three defenses:
//  1. every run-log record carries the node it ran on and whether its own
//     logs were readable, so "no evidence" vs "evidence unreadable on node X"
//     is distinguishable without probing;
//  2. the monitor sweep classifies a dead proxy path on a schedulable node;
//  3. the remediate prompt stops an engineer from losing the triggering
//     verdict (and their own session logs) to the same black hole.

const here = dirname(fileURLToPath(import.meta.url));
const chartDir = join(here, "..");
const probePath = join(chartDir, "probe-node-proxy.sh");

test("probe-node-proxy.sh exists, is POSIX sh, and only issues read-only calls", () => {
  assert.ok(existsSync(probePath), "probe script missing");
  const src = readFileSync(probePath, "utf8");
  assert.match(src, /^#!\/bin\/sh/, "probe must run under plain sh");
  // The monitor runs read-only kubectl only; the probe must not smuggle a
  // write through the same shell.
  for (const verb of ["delete", "patch", "apply", "edit", "scale", "rollout", "create", "replace", "exec"]) {
    assert.ok(
      !new RegExp("kubectl[^\\n]*\\b" + verb + "\\b").test(src),
      "probe must not invoke kubectl " + verb
    );
  }
  assert.match(src, /kubectl get --raw/, "probe must exercise the proxy subresource");
  assert.equal(spawnSync("sh", ["-n", probePath]).status, 0, "probe fails sh -n");
});

// --- probe behavior under a fake kubectl -----------------------------------
// The classification rules (which kubectl error text means BLACKHOLE vs auth
// vs dial-level) were each gotten wrong once in the lab; these scenarios pin
// them with the exact error strings real kubectl emits.

const FAKE_NODES = JSON.stringify({
  items: [
    {
      metadata: { name: "cp1", labels: { "node-role.kubernetes.io/control-plane": "" } },
      spec: { taints: [{ key: "node-role.kubernetes.io/control-plane", effect: "NoSchedule" }] },
      status: { addresses: [{ type: "InternalIP", address: "192.168.0.204" }], conditions: [{ type: "Ready", status: "True" }] },
    },
    {
      metadata: { name: "node1", labels: {} },
      spec: { taints: [] },
      status: { addresses: [{ type: "InternalIP", address: "192.168.0.201" }], conditions: [{ type: "Ready", status: "True" }] },
    },
    {
      metadata: { name: "node2", labels: {} },
      spec: { taints: [] },
      status: { addresses: [{ type: "InternalIP", address: "192.168.0.202" }], conditions: [{ type: "Ready", status: "True" }] },
    },
  ],
});

function runProbe(cases) {
  // cases: { [ipSubstring]: { out?, err?, rc } } plus an implicit nodes case.
  const dir = mkdtempSync(join(tmpdir(), "probe-fake-"));
  const nodesPath = join(dir, "nodes.json");
  writeFileSync(nodesPath, FAKE_NODES);
  const lines = ['#!/bin/sh', 'case "$*" in', `  "get nodes -o json") cat ${nodesPath} ;;`];
  for (const [ip, c] of Object.entries(cases)) {
    lines.push(`  *"${ip}:10250"*)`);
    if (c.out) lines.push(`    printf '%s\\n' ${JSON.stringify(c.out)}`);
    if (c.err) lines.push(`    printf '%s\\n' ${JSON.stringify(c.err)} >&2`);
    lines.push(`    exit ${c.rc ?? 0} ;;`);
  }
  lines.push("  *) exit 0 ;;", "esac");
  const bin = join(dir, "kubectl");
  writeFileSync(bin, lines.join("\n") + "\n", { mode: 0o755 });
  const r = spawnSync("sh", [probePath], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
    encoding: "utf8",
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const K403 =
  'Error from server (Forbidden): nodes "192.168.0.201:10250" is forbidden: User "system:serviceaccount:bionicorg:sre-harness-sa" cannot get resource "nodes/proxy" in API group "" at the cluster scope';
const K502 =
  'Error from server: Get "https://192.168.0.201:10250/proxy/healthz": proxy error from 127.0.0.1:6443 while dialing 192.168.0.201:10250, code 502: 502 Bad Gateway';
const KDIAL =
  'Error from server: Get "https://192.168.0.201:10250/proxy/healthz": dial tcp 192.168.0.201:10250: connect: connection refused';

test("probe: all nodes answering 401/403 (today's restricted SA) exits 0 but says partial", () => {
  const r = runProbe({
    "192.168.0.204": { err: K403, rc: 1 },
    "192.168.0.201": { err: K403, rc: 1 },
    "192.168.0.202": { err: K403, rc: 1 },
  });
  assert.equal(r.status, 0, "unjudged nodes must not fail the sweep");
  assert.match(r.stdout, /PASS\(partial\)/, "must not claim more than it saw");
  assert.doesNotMatch(r.stdout, /PASS: kubelet proxy path answered healthy/, "must not claim a clean pass");
  assert.match(r.stdout, /NOAUTH/);
});

test("probe: a 502 on a schedulable node is BLACKHOLE and exits 1 (2026-11-09 repro)", () => {
  const r = runProbe({
    "192.168.0.204": { err: K403, rc: 1 },
    "192.168.0.201": { err: K502, rc: 1 },
    "192.168.0.202": { out: "ok", rc: 0 },
  });
  assert.equal(r.status, 1, "black-holed schedulable node must fail the sweep");
  assert.match(r.stdout, /node1 .*BLACKHOLE/);
});

test("probe: 403 on a control-plane node does not fail, and the tainted node is not counted", () => {
  const r = runProbe({
    "192.168.0.204": { err: K403, rc: 1 },
    "192.168.0.201": { out: "ok", rc: 0 },
    "192.168.0.202": { out: "ok", rc: 0 },
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /PASS\(partial\)/);
});

test("probe: dial-refused node while another answers OK exits 1; all-dial-failure exits 3", () => {
  const mixed = runProbe({
    "192.168.0.204": { err: K403, rc: 1 },
    "192.168.0.201": { err: KDIAL, rc: 1 },
    "192.168.0.202": { out: "ok", rc: 0 },
  });
  assert.equal(mixed.status, 1, "a dial failure is real when other nodes answer");
  const blind = runProbe({
    "192.168.0.204": { err: KDIAL, rc: 1 },
    "192.168.0.201": { err: KDIAL, rc: 1 },
    "192.168.0.202": { err: KDIAL, rc: 1 },
  });
  assert.equal(blind.status, 3, "no node answered any status: probe is unusable, not a node verdict");
  assert.match(blind.stdout, /PROBE-UNUSABLE/);
});

test("probe: every node answering ok exits 0 with a clean pass", () => {
  const r = runProbe({
    "192.168.0.204": { out: "ok", rc: 0 },
    "192.168.0.201": { out: "ok", rc: 0 },
    "192.168.0.202": { out: "ok", rc: 0 },
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /PASS: kubelet proxy path answered healthy/);
});

// --- chart wiring -----------------------------------------------------------

test("both ConfigMaps ship the probe at /config/probe-node-proxy.sh, verbatim", () => {
  const r = spawnSync(
    "helm",
    ["template", "dsh-test", chartDir, "--namespace", "bionicorg"],
    { encoding: "utf8" }
  );
  if (r.error?.code === "ENOENT") {
    // helm not in this environment: fall back to the textual guard.
    for (const f of ["monitor-configmap.yaml", "remediate-configmap.yaml"]) {
      const cm = readFileSync(join(chartDir, "templates", f), "utf8");
      assert.match(cm, /probe-node-proxy\.sh: \|/, `${f} lost the probe key`);
    }
    return;
  }
  assert.equal(r.status, 0, `helm template failed: ${r.stderr}`);
  const docs = r.stdout.split(/^---$/m);
  const src = readFileSync(probePath, "utf8");
  for (const component of ["monitor", "remediate"]) {
    const doc = docs.find((d) => d.includes("kind: ConfigMap") && d.includes(`${component}-config`));
    assert.ok(doc, `${component} ConfigMap missing from render`);
    assert.ok(doc.includes("probe-node-proxy.sh: |"), `probe key missing from ${component} ConfigMap`);
    // The rendered copy must equal the source script -- helm's nindent can
    // add a trailing blank line; nothing else may differ. The probe is the
    // last key in both ConfigMaps, so the block runs to document end.
    const body = doc.slice(doc.indexOf("probe-node-proxy.sh: |")).split("\n").slice(1);
    const out = [];
    for (const line of body) {
      // A key line at the ConfigMap's indentation ends the block; blank
      // lines belong to the block text itself.
      if (/^ {0,2}\S.*:\s*\|?/.test(line)) break;
      out.push(line.slice(4));
    }
    const rendered = out.join("\n");
    assert.equal(rendered.trimEnd(), src.trimEnd(), `embedded probe drifted from probe-node-proxy.sh in ${component} ConfigMap`);
  }
});

test("run-log records self-locate: node + logReadable", () => {
  const helpers = readFileSync(join(chartDir, "templates", "_helpers.tpl"), "utf8");
  assert.match(helpers, /RUN_NODE=/, "record_run must capture the pod's node");
  assert.match(helpers, /RUN_LOGREADABLE=/, "record_run must test its own log readability");
  assert.match(helpers, /node: process\.env\.RUN_NODE/, "record must persist node");
  assert.match(helpers, /logReadable: process\.env\.RUN_LOGREADABLE/, "record must persist logReadable");
  // The readability probe must not be able to kill the run: it ends in `|| echo no`.
  const probeLine = helpers.match(/RUN_LOGREADABLE=[^\n]*/)[0];
  assert.match(probeLine, /\|\| echo no/, "log-readability probe must be failure-proof");
});

test("monitor sweep checks kubelet-proxy reachability and classifies it honestly", () => {
  const values = readFileSync(join(chartDir, "values.yaml"), "utf8");
  assert.match(values, /kubelet-proxy reachability/, "monitor prompt lost the proxy check");
  assert.match(values, /probe-node-proxy\.sh/, "check 6 must run the shipped probe");
  assert.match(values, /proxy\/healthz/, "check must exercise the proxy subresource path");
  assert.match(values, /502\/503 from the proxy hop/, "monitor must classify proxy-hop failures");
  assert.match(values, /HARNESS WARN/, "a black-holed node is a HARNESS WARN, not a Paperclip FAIL");
  // 401/403 must be treated as an unjudged auth verdict, never as proof the
  // proxy works: with the monitor's RBAC every node answers 403 today, and
  // calling that "alive" would have hidden a black hole behind RBAC noise.
  assert.doesNotMatch(
    values,
    /401\/403 = the proxy is alive/,
    "401/403 must not be described as proof the proxy works"
  );
  assert.match(values, /unjudged/, "401/403 nodes must be classified unjudged");
  assert.match(values, /PROBE-UNUSABLE/, "all-dial-failure must be UNKNOWN, not PASS");
  // The old unqualified claim that kubectl logs is "the forensic path" is gone.
  const monitorCm = readFileSync(join(chartDir, "templates", "monitor-configmap.yaml"), "utf8");
  assert.doesNotMatch(monitorCm, /kubectl logs job\/\.\.\. is the forensic path/);
});

test("remediate prompt falls back to the run-log when the monitor's logs are unreadable", () => {
  const values = readFileSync(join(chartDir, "values.yaml"), "utf8");
  assert.match(values, /If the log read answers 502\/proxy error/);
  assert.match(values, /read it from the durable\n      run-log ConfigMap/, "must point at the run-log CM");
  // Both command lines of the original instruction survive the fallback text.
  assert.match(values, /kubectl -n bionicorg get jobs -l app\.kubernetes\.io\/component=monitor --sort-by=\.metadata\.creationTimestamp/);
  assert.match(values, /kubectl -n bionicorg logs <newest monitor job>/);
});

#!/usr/bin/env node
// Gate for the monitor's verdict and its durable evidence trail.
//
// Two pieces of the SRE harness decide, without any code path a test covers,
// whether an operator is woken up and what they learn:
//
//   - the check-4 rule in values.yaml. kubectl collapses repeated event
//     warnings into ONE object, so `--sort-by=.lastTimestamp` drags a
//     condition that began hours earlier into the "last 40 minutes" filter.
//     On 2026-11-09 a readiness warning that started at 09:00 (count=6)
//     still headlined the 16:00 sweep and held it at WARN; the pod never left
//     Ready and `/health` answered every probe in 3ms.
//   - the excerpt in _helpers.tpl. A flat cap there clipped a WARN sweep's
//     record at "Fresh W...", so the durable run log - which the monitor
//     prompt points operators at - could not show the verdict it dispatched
//     for. The verdict line leads the final message, so any tail-truncating
//     cap eventually drops it.
//
// A `helm lint` pass cannot see either failure, so assert them directly on
// the source of truth. No helm binary required.
//
// Run: pnpm test:sre-harness-verdict-log
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const valuesPath = path.join(repoRoot, "deploy/helm/sre-harness/values.yaml");
const helpersPath = path.join(repoRoot, "deploy/helm/sre-harness/templates/_helpers.tpl");

const values = fs.readFileSync(valuesPath, "utf8");
const helpers = fs.readFileSync(helpersPath, "utf8");

const check4 = /^(\s{4}4\. `kubectl -n bionicorg get events[\s\S]*?)(?=^\s{4}\d\. |^\s{4}Your final message)/m.exec(values)?.[1] ?? "";

const cases = [];
const it = (name, ok) => cases.push([name, ok]);

// The false-positive rule: an event is only fresh when the CONDITION started
// inside the window, not when its newest repeat happened. The prose is
// allowed to name `.lastTimestamp` (it has to, to explain the trap) - what
// must not come back is a `--sort-by` on it, or the trap is back too.
it("check 4 exists in the monitor prompt", check4.length > 0);
it("check 4 sorts events by .firstTimestamp, not .lastTimestamp", /--sort-by=\.firstTimestamp/.test(check4) && !/--sort-by=\.lastTimestamp/.test(check4));
it("check 4 states the aggregation rule (.firstTimestamp/.count)", /\.firstTimestamp/.test(check4) && /\.count/.test(check4));
it("check 4 refuses to let a stale warning alone drive WARN/FAIL", /must not make the verdict\s*\n?\s*WARN or FAIL/.test(check4));

// The evidence trail: the verdict has to reach the durable run log.
const excerpt = /excerpt: String\(process\.env\.RUN_EXCERPT[^\n]*/.exec(helpers)?.[0] ?? "";
it("record_run still writes the excerpt from RUN_EXCERPT", excerpt.length > 0);
it("the excerpt is not tail-truncated (verdict line stays)", !/\.slice\(0,\s*-\d/.test(excerpt));
it("the excerpt budget fits a full sweep report (>= 1500 chars)", (Number(/slice\(0,\s*(\d+)\)/.exec(excerpt)?.[1] ?? 0) >= 1500) || !/slice\(0,/.test(excerpt));

let failed = 0;
for (const [name, ok] of cases) {
  if (!ok) {
    console.log(`FAIL  ${name}`);
    failed += 1;
    continue;
  }
  console.log(`ok    ${name}`);
}

if (failed) {
  console.error(`\n[sre-harness-verdict-log] ${failed}/${cases.length} check(s) failed`);
  process.exit(1);
}
console.log(`\n[sre-harness-verdict-log] all ${cases.length} checks pass`);

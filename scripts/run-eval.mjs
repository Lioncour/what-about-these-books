// Runs the evals against the app's local server (start it first: `npm run dev:web`).
// Exit code: 0 when every case passed (or the server isn't running: a hint is printed),
// 2 when a case failed, 1 when the server answered with an error.
//
//   npm run eval:harness            retrieval eval (eval/gold-questions.json)
//   npm run eval:chat               chat eval, dry: routes, scope, exact answers, planned calls
//   npm run eval:chat -- --live     chat eval with real Claude calls (costs tokens)
//   npm run eval:chat -- id1 id2    only these cases
//   ... --json                      print the full report as JSON
//   ... --save-baseline             remember this run (eval/baseline-dry.json or -live.json)
//
// When a baseline for the mode exists, every chat run ends with what changed against it:
// cases that pass or fail differently, a different route or scope, more or fewer Claude
// calls and, for live runs, a clear change in tokens.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compareWithBaseline, mergeBaseline, toBaseline } from "./eval-baseline.mjs";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const base = process.env.EVAL_URL || "http://127.0.0.1:3000/api/eval";
const chat = flag("--chat");
const live = flag("--live");
const ids = args.filter((a) => !a.startsWith("--"));

/**
 * POST without a response timeout. A live run of every case takes minutes before the
 * first byte comes back, and fetch gives up after five (then the run's result is lost
 * although the server finished and the tokens were spent).
 */
function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        host: target.hostname,
        port: target.port || 80,
        path: target.pathname + target.search,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (d) => (text += d));
        res.on("end", () =>
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            statusText: res.statusMessage || "",
            text: async () => text,
            json: async () => JSON.parse(text),
          })
        );
      }
    );
    req.setTimeout(0);
    req.on("error", reject);
    req.end(payload);
  });
}

let res;
try {
  res = chat ? await postJson(base, { live, ids }) : await fetch(base);
} catch (error) {
  const why = error.cause?.code || error.message;
  console.error(`Eval skipped: no server at ${base} (${why}). Start the app (npm run dev:web) or set EVAL_URL.`);
  process.exit(0);
}
if (!res.ok) {
  console.error(`Eval request failed: ${res.status} ${res.statusText}\n${await res.text()}`);
  process.exit(1);
}
const report = await res.json();

if (!chat || flag("--json")) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  for (const r of report.results) {
    const o = r.observed;
    const scope =
      o.scopeBooks.length + o.scopeMore === 0
        ? "no books"
        : `${o.scopeBooks.slice(0, 3).join(", ")}${o.scopeBooks.length + o.scopeMore > 3 ? ` +${o.scopeBooks.length + o.scopeMore - 3}` : ""}`;
    const cost = live ? `${o.claudeCalls} calls, ${k(o.inputTokens)} in, ${k(o.outputTokens)} out` : `${o.claudeCalls} planned calls`;
    console.log(`${r.passed ? "PASS" : "FAIL"}  ${r.id}`);
    const router = o.routerAsked ? (live ? " (router model asked)" : " (router model planned)") : "";
    console.log(`      ${o.route ?? "?"}${router} · ${o.scopeReason ?? "?"}: ${scope} · ${cost} · ${(o.ms / 1000).toFixed(1)} s`);
    for (const f of r.failures) console.log(`      ✗ ${f}`);
    for (const s of r.skipped) console.log(`      – skipped ${s}`);
  }
  const total = live
    ? `${report.claudeCalls} Claude calls, ${k(report.inputTokens)} tokens in, ${k(report.outputTokens)} out`
    : `${report.claudeCalls} Claude calls planned, none made`;
  console.log(`\n${report.passed}/${report.total} passed (${report.mode}) · ${total} · ${(report.ms / 1000).toFixed(1)} s`);
}
if (chat && Array.isArray(report.results)) {
  const file = join(dirname(fileURLToPath(import.meta.url)), "..", "eval", `baseline-${report.mode}.json`);
  let baseline = null;
  try {
    if (existsSync(file)) baseline = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    console.error(`Could not read ${file}; ignoring it.`);
  }
  if (!flag("--json")) {
    const diff = compareWithBaseline(report, baseline);
    if (diff.lines.length) console.log(`\n${diff.lines.join("\n")}`);
    else if (!flag("--save-baseline")) {
      console.log("\nNo baseline for this mode yet. Add --save-baseline to keep this run as one.");
    }
  }
  if (flag("--save-baseline")) {
    writeFileSync(file, JSON.stringify(mergeBaseline(baseline, toBaseline(report)), null, 2) + "\n");
    console.log(`Saved ${ids.length ? `${report.results.length} case(s) into` : "this run as"} eval/baseline-${report.mode}.json`);
  }
}

if (report.failed > 0) process.exitCode = 2;

// Runs the evals against the app's local server (start it first: `npm run dev:web`).
// Exit code: 0 when every case passed (or the server isn't running: a hint is printed),
// 2 when a case failed, 1 when the server answered with an error.
//
//   npm run eval:harness            retrieval eval (eval/gold-questions.json)
//   npm run eval:chat               chat eval, dry: routes, scope, exact answers, planned calls
//   npm run eval:chat -- --live     chat eval with real Claude calls (costs tokens)
//   npm run eval:chat -- id1 id2    only these cases
//   ... --json                      print the full report as JSON

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const base = process.env.EVAL_URL || "http://127.0.0.1:3000/api/eval";
const chat = flag("--chat");
const live = flag("--live");
const ids = args.filter((a) => !a.startsWith("--"));

let res;
try {
  res = chat
    ? await fetch(base, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ live, ids }),
      })
    : await fetch(base);
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
    console.log(`      ${o.route ?? "?"} · ${o.scopeReason ?? "?"}: ${scope} · ${cost} · ${(o.ms / 1000).toFixed(1)} s`);
    for (const f of r.failures) console.log(`      ✗ ${f}`);
    for (const s of r.skipped) console.log(`      – skipped ${s}`);
  }
  const total = live
    ? `${report.claudeCalls} Claude calls, ${k(report.inputTokens)} tokens in, ${k(report.outputTokens)} out`
    : `${report.claudeCalls} Claude calls planned, none made`;
  console.log(`\n${report.passed}/${report.total} passed (${report.mode}) · ${total} · ${(report.ms / 1000).toFixed(1)} s`);
}
if (report.failed > 0) process.exitCode = 2;

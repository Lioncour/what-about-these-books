// Baselines for the chat eval: what each case cost and whether it passed, saved so the
// next run can say what a change did. Pure functions; run-eval.mjs does the file work.

/** The part of a report worth remembering. */
export function toBaseline(report) {
  const cases = {};
  for (const r of report.results) {
    const o = r.observed;
    cases[r.id] = {
      passed: r.passed,
      route: o.route,
      scopeReason: o.scopeReason,
      books: o.scopeBooks.length + (o.scopeMore || 0),
      claudeCalls: o.claudeCalls,
      inputTokens: o.inputTokens,
      outputTokens: o.outputTokens,
    };
  }
  return { mode: report.mode, cases };
}

/** Merge a partial run (some case ids) into an existing baseline of the same mode. */
export function mergeBaseline(existing, fresh) {
  if (!existing || existing.mode !== fresh.mode) return fresh;
  return { mode: fresh.mode, cases: { ...existing.cases, ...fresh.cases } };
}

const k = (n) => (Math.abs(n) >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const signed = (n) => (n > 0 ? `+${k(n)}` : k(n));

/** Token counts wobble between live runs; only a change this large is worth a line. */
const TOKEN_NOISE = 0.15;
const TOKEN_FLOOR = 500;

/**
 * Compare a report with a baseline of the same mode.
 * Returns the lines to print, and how many cases got worse (a pass that now fails, or
 * more Claude calls for the same question) and better.
 */
export function compareWithBaseline(report, baseline) {
  const lines = [];
  let worse = 0;
  let better = 0;
  if (!baseline || baseline.mode !== report.mode) return { lines, worse, better, compared: 0 };

  const live = report.mode === "live";
  let compared = 0;
  let calls = 0;
  let tokensIn = 0;
  let tokensOut = 0;

  for (const r of report.results) {
    const was = baseline.cases[r.id];
    const o = r.observed;
    if (!was) {
      lines.push(`  new   ${r.id}: ${r.passed ? "passes" : "fails"}, ${o.claudeCalls} calls`);
      continue;
    }
    compared += 1;
    const notes = [];
    let caseWorse = false;
    let caseBetter = false;

    if (was.passed && !r.passed) {
      notes.push("passed before, FAILS now");
      caseWorse = true;
    } else if (!was.passed && r.passed) {
      notes.push("failed before, passes now");
      caseBetter = true;
    }
    if (was.route !== o.route) notes.push(`route ${was.route ?? "?"} → ${o.route ?? "?"}`);
    if (was.scopeReason !== o.scopeReason) notes.push(`scope ${was.scopeReason ?? "?"} → ${o.scopeReason ?? "?"}`);
    const books = o.scopeBooks.length + (o.scopeMore || 0);
    if (was.books !== books) notes.push(`books read ${was.books} → ${books}`);
    if (was.claudeCalls !== o.claudeCalls) {
      notes.push(`calls ${was.claudeCalls} → ${o.claudeCalls}`);
      if (o.claudeCalls > was.claudeCalls) caseWorse = true;
      else caseBetter = true;
    }
    if (live) {
      const delta = o.inputTokens - was.inputTokens;
      if (Math.abs(delta) > Math.max(TOKEN_FLOOR, was.inputTokens * TOKEN_NOISE)) {
        const pct = was.inputTokens ? ` (${signed(Math.round((delta / was.inputTokens) * 100))}%)` : "";
        notes.push(`tokens in ${k(was.inputTokens)} → ${k(o.inputTokens)}${pct}`);
      }
    }
    calls += o.claudeCalls - was.claudeCalls;
    tokensIn += o.inputTokens - was.inputTokens;
    tokensOut += o.outputTokens - was.outputTokens;

    if (caseWorse) worse += 1;
    else if (caseBetter) better += 1;
    if (notes.length) lines.push(`  ${caseWorse ? "worse " : caseBetter ? "better" : "change"} ${r.id}: ${notes.join("; ")}`);
  }

  const ran = new Set(report.results.map((r) => r.id));
  const missing = Object.keys(baseline.cases).filter((id) => !ran.has(id));
  // A run of selected cases isn't expected to cover the baseline.
  if (missing.length && report.results.length >= Object.keys(baseline.cases).length) {
    lines.push(`  gone  ${missing.join(", ")}`);
  }

  const totals = [`${signed(calls)} Claude calls`];
  if (live) totals.push(`${signed(tokensIn)} tokens in`, `${signed(tokensOut)} out`);
  const summary =
    lines.length === 0
      ? `Same as the baseline (${compared} cases).`
      : `Against the baseline (${compared} cases): ${totals.join(", ")}; ${worse} worse, ${better} better.`;
  return { lines: [...lines, summary], worse, better, compared };
}

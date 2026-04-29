const url = process.env.EVAL_URL || "http://127.0.0.1:3000/api/eval";

const res = await fetch(url);
if (!res.ok) {
  console.error(`Eval request failed: ${res.status} ${res.statusText}`);
  process.exit(1);
}
const report = await res.json();
console.log(JSON.stringify(report, null, 2));
if (report.failed > 0) process.exitCode = 2;

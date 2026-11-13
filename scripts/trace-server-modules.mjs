// Shows which files in the standalone build's node_modules the server really loads.
//
//   npm run build
//   node scripts/trace-server-modules.mjs            table: size per package, loaded or not
//   node scripts/trace-server-modules.mjs --json f   also write the full record to file f
//
// It runs the standalone server from a copy outside the project (so nothing is borrowed
// from the project's node_modules) with a preload that records every module Node resolves
// and every file read inside node_modules, then uses the app over HTTP: pages, the read
// APIs, an exact-count chat question, and an EPUB and a TXT upload made up on the spot.
// The library is an empty temp folder and AWS is pointed at an empty config, so no real
// data is touched and no Bedrock call can succeed; uploads stop at the embedding step,
// after the parsing code has loaded. Exit code 1 when the server could not find a module
// or the upload parsers did not load.

import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { sampleEpub, sampleText } from "./sample-books.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const jsonOut = args.includes("--json") ? args[args.indexOf("--json") + 1] : null;
const built = join(root, ".next", "standalone");
if (!existsSync(join(built, "server.js"))) {
  console.error("No standalone build. Run `npm run build` first.");
  process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), "wabt-trace-"));
const copy = join(work, "standalone");
const dataDir = join(work, "data");
const traceFile = join(work, "trace.txt");
cpSync(built, copy, { recursive: true });

// The preload: CommonJS resolutions, ES module loads and file reads, one line each.
const preload = join(work, "preload.cjs");
const loader = join(work, "loader.mjs");
writeFileSync(
  loader,
  `import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
export async function load(url, context, nextLoad) {
  if (url.startsWith("file:")) {
    try { appendFileSync(process.env.WABT_TRACE_FILE, "import\\t" + fileURLToPath(url) + "\\n"); } catch {}
  }
  return nextLoad(url, context);
}
`
);
writeFileSync(
  preload,
  `const Module = require("module");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const out = process.env.WABT_TRACE_FILE;
const seen = new Set();
const note = (kind, file) => {
  if (typeof file !== "string" || !path.isAbsolute(file)) return;
  const key = kind + "\\t" + file;
  if (seen.has(key)) return;
  seen.add(key);
  try { fs.appendFileSync(out, key + "\\n"); } catch {}
};
const resolve = Module._resolveFilename;
Module._resolveFilename = function (...a) {
  const found = resolve.apply(this, a);
  note("require", found);
  return found;
};
const inModules = (p) => typeof p === "string" && p.includes(path.sep + "node_modules" + path.sep);
for (const name of ["readFileSync", "readFile", "createReadStream", "openSync", "open"]) {
  const original = fs[name];
  fs[name] = function (p, ...rest) {
    if (inModules(p)) note("read", p);
    return original.call(this, p, ...rest);
  };
}
const readFile = fs.promises.readFile;
fs.promises.readFile = function (p, ...rest) {
  if (inModules(p)) note("read", p);
  return readFile.call(this, p, ...rest);
};
try { Module.register?.(pathToFileURL(${JSON.stringify(loader)})); } catch {}
`
);

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// No AWS: an empty config and a profile that isn't in it. The AWS CLI and SDK both fail
// at once, without a browser login and without reading the real ~/.aws.
const emptyAws = join(work, "aws-empty");
writeFileSync(emptyAws, "");
const env = { ...process.env };
for (const key of Object.keys(env)) if (/^AWS_/i.test(key)) delete env[key];
const port = await freePort();
Object.assign(env, {
  NODE_ENV: "production",
  PORT: String(port),
  HOSTNAME: "127.0.0.1",
  DATA_DIR: dataDir,
  WABT_TRACE_FILE: traceFile,
  AWS_CONFIG_FILE: emptyAws,
  AWS_SHARED_CREDENTIALS_FILE: emptyAws,
  AWS_PROFILE: "wabt-trace-no-aws",
  AWS_EC2_METADATA_DISABLED: "true",
});

const output = [];
const child = spawn(process.execPath, ["--require", preload, "server.js"], { cwd: copy, env, stdio: ["ignore", "pipe", "pipe"] });
child.stdout.on("data", (d) => output.push(String(d)));
child.stderr.on("data", (d) => output.push(String(d)));
let exited = false;
child.on("exit", () => (exited = true));

const base = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(label, path, init) {
  try {
    const res = await fetch(base + path, { ...init, signal: AbortSignal.timeout(180_000) });
    const text = await res.text();
    const last = text.trim().split(/\r?\n/).pop() || "";
    console.log(`  ${String(res.status).padEnd(4)} ${label}${init ? `  -> ${last.slice(0, 110)}` : ""}`);
    return text;
  } catch (error) {
    console.log(`  ERR  ${label}: ${error.message}`);
    return "";
  }
}
const postJson = (body) => ({ method: "POST", headers: { "Content-Type": "application/json", Origin: base }, body: JSON.stringify(body) });
const upload = (name, bytes, type) => {
  const form = new FormData();
  form.append("file", new Blob([bytes], { type }), name);
  return { method: "POST", headers: { Origin: base }, body: form };
};

let problems = 0;
try {
  let up = false;
  for (let i = 0; i < 120 && !up && !exited; i++) {
    try {
      up = (await fetch(`${base}/api/config`, { signal: AbortSignal.timeout(3000) })).ok;
    } catch {
      await sleep(500);
    }
  }
  if (!up) throw new Error("the standalone server did not start");

  console.log("Requests:");
  for (const path of ["/", "/settings", "/api/books", "/api/series", "/api/settings", "/api/chats", "/api/token-usage", "/api/knowledge", "/api/config"]) {
    await call(`GET ${path}`, path);
  }
  await call("POST /api/chat/scope", "/api/chat/scope", postJson({ question: "What happens first?" }));
  await call(
    "POST /api/chat (exact count)",
    "/api/chat",
    postJson({ bookId: "all", bookTitle: "All books", messages: [{ role: "user", content: "How many times is the mentioned?" }] })
  );
  await call("POST /api/extract (epub)", "/api/extract", upload("wabt-trace-sample.epub", sampleEpub(), "application/epub+zip"));
  await call("POST /api/extract (txt)", "/api/extract", upload("wabt-trace-notes.txt", Buffer.from(sampleText), "text/plain"));
} catch (error) {
  console.error(`Trace run failed: ${error.message}`);
  problems++;
} finally {
  if (!exited) {
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    else child.kill();
  }
  await sleep(500);
}

// What was loaded, per package.
const modulesDir = join(copy, "node_modules");
const linkDir = join(copy, ".next", "node_modules");
const records = existsSync(traceFile) ? readFileSync(traceFile, "utf8").split(/\r?\n/).filter(Boolean).map((l) => l.split("\t")) : [];
const packageOf = (file) => {
  for (const dir of [modulesDir, linkDir]) {
    if (!file.startsWith(dir + sep)) continue;
    const parts = file.slice(dir.length + 1).split(sep);
    const name = parts[0].startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
    return dir === linkDir ? name.replace(/-[0-9a-f]{8,}$/, "") : name;
  }
  return null;
};
const loaded = new Map(); // package -> Set of files
for (const [, file] of records) {
  const name = packageOf(file);
  if (!name) continue;
  if (!loaded.has(name)) loaded.set(name, new Set());
  loaded.get(name).add(file);
}
const sizeOf = (p) => {
  const stat = lstatSync(p);
  if (!stat.isDirectory()) return stat.size;
  return readdirSync(p).reduce((n, e) => n + sizeOf(join(p, e)), 0);
};
const rows = [];
for (const entry of readdirSync(modulesDir)) {
  const names = entry.startsWith("@") ? readdirSync(join(modulesDir, entry)).map((n) => `${entry}/${n}`) : [entry];
  for (const name of names) rows.push({ name, bytes: sizeOf(join(modulesDir, name)), files: loaded.get(name)?.size || 0 });
}
rows.sort((a, b) => b.bytes - a.bytes);
const mb = (n) => (n / 1048576).toFixed(2).padStart(8);
console.log(`\nnode_modules in the standalone build (${rows.length} packages, ${mb(rows.reduce((n, r) => n + r.bytes, 0)).trim()} MB):`);
for (const row of rows) console.log(`${mb(row.bytes)} MB  ${row.files ? `loaded (${row.files} files)`.padEnd(20) : "never loaded".padEnd(20)}  ${row.name}`);
const unused = rows.filter((r) => !r.files);
console.log(`\nNever loaded: ${unused.length} packages, ${mb(unused.reduce((n, r) => n + r.bytes, 0)).trim()} MB`);

const text = output.join("");
const missing = [...new Set(text.match(/Cannot find (?:module|package) '[^']+'/g) || [])];
if (missing.length || /MODULE_NOT_FOUND/.test(text)) {
  console.error(`\nThe server could not find modules: ${missing.join("; ") || "MODULE_NOT_FOUND"}`);
  problems++;
}
for (const needed of ["epub2", "adm-zip", "vectra"]) {
  if (!loaded.has(needed)) {
    console.error(`\nExpected ${needed} to load during the uploads; it did not.`);
    problems++;
  }
}
if (jsonOut) {
  writeFileSync(
    jsonOut,
    JSON.stringify(
      {
        packages: rows,
        files: records.map(([kind, file]) => ({ kind, file: file.startsWith(copy) ? file.slice(copy.length + 1).split(sep).join("/") : file })).filter((r) => !/^[A-Za-z]:|^\//.test(r.file)),
        output: text.split(/\r?\n/).slice(-80),
      },
      null,
      1
    )
  );
  console.log(`\nWrote ${jsonOut}`);
}
try {
  rmSync(work, { recursive: true, force: true });
} catch {
  /* a late file handle on Windows: the temp dir is harmless */
}
process.exit(problems ? 1 : 0);

// Launches the desktop app for real and checks the things a unit test can't:
// the port pick, the server child process, the window, and a clean quit.
//
//   node scripts/electron-smoke.mjs              dev server (next dev), empty temp library
//   node scripts/electron-smoke.mjs --prod       the standalone build (run `npm run build` first)
//   node scripts/electron-smoke.mjs --packaged   the packaged app in dist/win-unpacked or dist/linux-unpacked
//                                                (run `npm run dist` / `electron-builder --linux` first)
//   node scripts/electron-smoke.mjs --busy-port  occupy port 3000 first: the app must move
//   node scripts/electron-smoke.mjs --real-data  use your own library instead of a temp one
//
// Every run is cut off from AWS (an empty config and a profile that isn't in it), so it
// costs nothing and never opens a login page. The upload check therefore ends at the
// embedding step; what it proves is that everything up to there could be loaded. A
// "Cannot find module" anywhere, in a response or in the app's output, fails the run:
// that is how a build that ships too little shows itself.
//
// Exit code 0 when every check passed. In CI run it under xvfb (see ci.yml).

import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const electronPath = createRequire(import.meta.url)("electron");
const DEBUG_PORT = 9333;
const START_TIMEOUT_MS = 240_000;
const QUIT_TIMEOUT_MS = 20_000;

const checks = [];
const check = (name, ok, detail = "") => {
  checks.push({ name, ok });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, json: JSON.parse(body) });
        } catch {
          resolve({ status: res.statusCode, json: null, body });
        }
      });
    });
    req.setTimeout(5000, () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

/** True when something accepts connections on 127.0.0.1:port. */
function isListening(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    socket.setTimeout(1500);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(false));
  });
}

const MISSING_MODULE = /Cannot find (module|package)|MODULE_NOT_FOUND/;
const lastLine = (text) => (text.trim().split(/\r?\n/).pop() || "").slice(0, 120);

/** POST to the app; resolves with the status and the whole (streamed) body, never throws. */
async function post(path, init) {
  try {
    const res = await fetch(`http://127.0.0.1:${appPort}${path}`, { method: "POST", ...init, signal: AbortSignal.timeout(180_000) });
    return { status: res.status, text: await res.text() };
  } catch (error) {
    return { status: 0, text: String(error?.message || error) };
  }
}

let blocker = null;
if (flag("--busy-port")) {
  // Listen the way `next dev` does by default (all interfaces), which is the case that
  // matters: another dev server already running on 3000.
  blocker = http.createServer((_req, res) => res.end("not the app"));
  await new Promise((resolve, reject) => {
    blocker.once("error", reject);
    blocker.listen(3000, resolve);
  });
  console.log("port 3000 is occupied by a decoy server");
}

const dataDir = flag("--real-data") ? null : mkdtempSync(join(tmpdir(), "wabt-smoke-"));

// --prod runs the standalone build from a copy outside the project. Inside the project
// Node resolves anything the build forgot from the project's own node_modules, which
// hides exactly the failures an installed app would have.
let standaloneCopy = null;
if (flag("--prod")) {
  const built = join(root, ".next", "standalone");
  if (!existsSync(join(built, "server.js"))) {
    console.error("No standalone build. Run `npm run build` first.");
    process.exit(1);
  }
  standaloneCopy = mkdtempSync(join(tmpdir(), "wabt-standalone-"));
  cpSync(built, standaloneCopy, { recursive: true });
}
// No AWS: the CLI and the SDK both fail at once on a profile that is in no config file,
// without a browser login and without reading the real ~/.aws. (electron/main.js leaves
// the user's own settings file out when WABT_SMOKE is set.)
const awsDir = mkdtempSync(join(tmpdir(), "wabt-smoke-aws-"));
const emptyAws = join(awsDir, "config");
writeFileSync(emptyAws, "");
const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^AWS_/i.test(key)));
const env = {
  ...inherited,
  AWS_CONFIG_FILE: emptyAws,
  AWS_SHARED_CREDENTIALS_FILE: emptyAws,
  AWS_PROFILE: "wabt-smoke-no-aws",
  AWS_EC2_METADATA_DISABLED: "true",
  WABT_SMOKE: "1",
  ...(dataDir ? { DATA_DIR: dataDir } : {}),
  ...(standaloneCopy ? { NODE_ENV: "production", WABT_STANDALONE_DIR: standaloneCopy } : {}),
};
delete env.ELECTRON_RUN_AS_NODE;

// --packaged runs the built app from dist/<platform>-unpacked (after `npm run dist`, or
// `electron-builder --linux`). The Linux name is `linux.executableName` in package.json.
const packagedExe =
  process.platform === "win32"
    ? join(root, "dist", "win-unpacked", "What About This Book.exe")
    : join(root, "dist", "linux-unpacked", JSON.parse(readFileSync(join(root, "package.json"), "utf8")).build?.linux?.executableName || "whataboutthisbook");
if (flag("--packaged") && !existsSync(packagedExe)) {
  console.error(`No packaged app at ${packagedExe}. Build it first.`);
  process.exit(1);
}
const launchPath = flag("--packaged") ? packagedExe : electronPath;
const electronArgs = [...(flag("--packaged") ? [] : ["."]), `--remote-debugging-port=${DEBUG_PORT}`];
if (process.env.CI) electronArgs.push("--no-sandbox", "--disable-gpu");

const output = [];
const child = spawn(launchPath, electronArgs, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
child.stdout.on("data", (d) => output.push(String(d)));
child.stderr.on("data", (d) => output.push(String(d)));
let exited = null;
child.on("exit", (code, signal) => (exited = { code, signal }));

let appPort = null;
try {
  // 1. A window appears, showing the app from a loopback port.
  let target = null;
  const started = Date.now();
  while (!target && !exited && Date.now() - started < START_TIMEOUT_MS) {
    try {
      const { json } = await getJson(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
      target = (json || []).find((t) => t.type === "page" && /^http:\/\/127\.0\.0\.1:\d+\//.test(t.url)) || null;
    } catch {
      /* not up yet */
    }
    if (!target) await sleep(1000);
  }
  check("a window opened on the app", !!target, target ? target.url : exited ? `exited ${exited.code}` : "timeout");
  if (!target) throw new Error("no window");

  appPort = Number(new URL(target.url).port);
  if (flag("--busy-port")) check("moved off the busy port", appPort !== 3000, `port ${appPort}`);
  else check("uses a port in 3000-3010", appPort >= 3000 && appPort <= 3010, `port ${appPort}`);

  // 2. The page is ours and its API answers.
  for (let i = 0; i < 30 && target.title !== "What About This Book?"; i++) {
    await sleep(1000);
    const { json } = await getJson(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
    target = (json || []).find((t) => t.id === target.id) || target;
  }
  check("the window shows the app", target.title === "What About This Book?", `title "${target.title}"`);

  const books = await getJson(`http://127.0.0.1:${appPort}/api/books`);
  check("the local API answers", books.status === 200 && Array.isArray(books.json?.books), `${books.status}, ${books.json?.books?.length ?? "?"} books`);

  // Every kind of route loads: catalog, settings, series, usage, and the settings page.
  for (const path of ["/api/settings", "/api/series", "/api/token-usage", "/api/chats", "/settings"]) {
    const res = await new Promise((resolve) => {
      const req = http.get(`http://127.0.0.1:${appPort}${path}`, (r) => {
        r.resume();
        resolve(r.statusCode);
      });
      req.setTimeout(30000, () => req.destroy());
      req.on("error", () => resolve(0));
    });
    check(`${path} loads`, res === 200, `status ${res}`);
  }

  // A POST through the chat code (catalog only, no AI call).
  const scope = await new Promise((resolve) => {
    const req = http.request(
      { host: "127.0.0.1", port: appPort, path: "/api/chat/scope", method: "POST", headers: { "Content-Type": "application/json" } },
      (r) => {
        r.resume();
        resolve(r.statusCode);
      }
    );
    req.setTimeout(30000, () => req.destroy());
    req.on("error", () => resolve(0));
    req.end(JSON.stringify({ question: "What happens first?" }));
  });
  check("the chat scope preview answers", scope === 200, `status ${scope}`);

  // An exact-count question: the whole chat route, answered from the text files with no
  // AI call (and an empty library has nothing to count).
  const count = await post("/api/chat", {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bookId: "all", bookTitle: "All books", messages: [{ role: "user", content: "How many times is the mentioned?" }] }),
  });
  check(
    "an exact-count chat question answers",
    count.status === 200 && /^USAGE:/m.test(count.text) && !MISSING_MODULE.test(count.text),
    `status ${count.status}, ${lastLine(count.text)}`
  );

  // A tiny TXT upload: parsing, chunking and the index code all load; the embedding call
  // is where it stops without AWS. Never against a real library.
  if (dataDir) {
    const form = new FormData();
    const words = Array.from({ length: 40 }, (_, i) => `The lighthouse keeper counted the ships again on day ${i + 1}.`).join(" ");
    form.append("file", new Blob([words], { type: "text/plain" }), "wabt-smoke-notes.txt");
    const upload = await post("/api/extract", { body: form });
    const reachedEmbedding = /^PROGRESS:.*embeddings/m.test(upload.text);
    const finished = /^DONE:/m.test(upload.text) || /^ERROR:.*(embedding|AWS|credential|SSO)/im.test(upload.text);
    check(
      "a TXT upload gets as far as the embedding step",
      upload.status === 200 && reachedEmbedding && finished && !MISSING_MODULE.test(upload.text),
      `status ${upload.status}, ${lastLine(upload.text)}`
    );
  }

  const cross = await new Promise((resolve) => {
    const req = http.request(
      { host: "127.0.0.1", port: appPort, path: "/api/settings", method: "POST", headers: { Origin: "http://evil.example", "Content-Type": "application/json" } },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      }
    );
    req.on("error", () => resolve(0));
    req.end("{}");
  });
  check("cross-origin writes are refused", cross === 403, `status ${cross}`);

  // 3. Closing the window quits the app and takes the server with it.
  await getJson(`http://127.0.0.1:${DEBUG_PORT}/json/close/${target.id}`).catch(() => {});
  const closing = Date.now();
  while (!exited && Date.now() - closing < QUIT_TIMEOUT_MS) await sleep(250);
  check("closing the window quits the app", !!exited, exited ? `exit code ${exited.code}` : "still running");

  let stillUp = true;
  for (let i = 0; i < 20 && stillUp; i++) {
    stillUp = await isListening(appPort);
    if (stillUp) await sleep(500);
  }
  check("the local server is gone after quit", !stillUp, `port ${appPort}`);
} catch (error) {
  check("smoke run completed", false, error.message);
} finally {
  if (!exited) {
    // Take the server child down too; killing only the main process would orphan it.
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      child.kill();
    }
  }
  blocker?.close();
  for (const dir of [dataDir, standaloneCopy, awsDir]) {
    if (!dir) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* a late file handle on Windows: the temp dir is harmless */
    }
  }
}

// A module the build forgot shows up in the app's output even when the request that
// needed it was not one of ours.
const appOutput = output.join("");
const missing = [...new Set(appOutput.split(/\r?\n/).filter((line) => MISSING_MODULE.test(line)).map((line) => line.trim().slice(0, 160)))];
check("the app never failed to find a module", missing.length === 0, missing.length ? missing.slice(0, 3).join(" | ") : "output scanned");

const failed = checks.filter((c) => !c.ok);
if (failed.length) {
  console.log("\n--- app output (last lines) ---");
  console.log(appOutput.split(/\r?\n/).slice(-40).join("\n"));
}
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);

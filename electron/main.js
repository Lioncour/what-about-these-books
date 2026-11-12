const { app, BrowserWindow, Menu, dialog } = require("electron");
const { spawn, spawnSync } = require("child_process");
const path = require("path");
const http = require("http");
const net = require("net");
const fs = require("fs");
const os = require("os");

const PREFERRED_PORT = Number(process.env.PORT) || 3000;
const PORT_RANGE = [3000, 3010];
// The port the spawned server actually got; set by pickPort() before spawning.
let PORT = PREFERRED_PORT;
const isProd = app.isPackaged || process.env.NODE_ENV === "production";

let mainWindow;
let nextProcess;
let nextExited = null; // { code, signal } once the server process has exited
let serverReady = false; // true once waitForServer succeeded
const stderrTail = [];
const STDERR_TAIL_LINES = 30;

function rememberStderr(chunk) {
  for (const line of String(chunk).split(/\r?\n/)) {
    if (!line.trim()) continue;
    stderrTail.push(line);
    if (stderrTail.length > STDERR_TAIL_LINES) stderrTail.shift();
  }
}

function stderrSummary() {
  return stderrTail.length ? `\n\n${stderrTail.join("\n")}` : "";
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ port, host: "127.0.0.1", exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

/** Return the preferred port if free, else the first free port in PORT_RANGE. */
async function pickPort() {
  if (await isPortFree(PREFERRED_PORT)) return PREFERRED_PORT;
  for (let p = PORT_RANGE[0]; p <= PORT_RANGE[1]; p++) {
    if (p === PREFERRED_PORT) continue;
    if (await isPortFree(p)) return p;
  }
  throw new Error(
    `No free port between ${PORT_RANGE[0]} and ${PORT_RANGE[1]} on 127.0.0.1.`
  );
}

/** Kill the server and its whole process tree. Safe to call repeatedly. */
function killServer() {
  const proc = nextProcess;
  if (!proc || proc.killed || nextExited || proc.exitCode !== null) return;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } else {
      try {
        process.kill(-proc.pid, "SIGTERM");
      } catch {
        proc.kill("SIGTERM");
      }
    }
  } catch {
    // already gone
  }
}

function getAppRoot() {
  return app.isPackaged ? app.getAppPath() : path.join(__dirname, "..");
}

function getStandaloneDir() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "standalone");
  }
  return path.join(getAppRoot(), ".next", "standalone");
}

function getStandaloneServer() {
  return path.join(getStandaloneDir(), "server.js");
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const out = {};
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function ensureUserConfig() {
  const dataDir = path.join(os.homedir(), ".whataboutthisbook");
  const envFile = path.join(dataDir, ".env");
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(envFile)) {
    const example = path.join(getAppRoot(), ".env.example");
    if (fs.existsSync(example)) {
      fs.copyFileSync(example, envFile);
    }
  }
  return envFile;
}

function getBootstrapEnv() {
  ensureUserConfig();
  const userEnv = path.join(os.homedir(), ".whataboutthisbook", ".env");
  const besideExe = path.join(path.dirname(process.execPath), ".env");
  let merged = { ...loadEnvFile(userEnv), ...loadEnvFile(besideExe) };
  if (!app.isPackaged) {
    merged = { ...merged, ...loadEnvFile(path.join(getAppRoot(), ".env")) };
  }
  return merged;
}

function getNextBin() {
  return path.join(getAppRoot(), "node_modules", "next", "dist", "bin", "next");
}

function usesStandaloneServer() {
  return isProd && fs.existsSync(getStandaloneServer());
}

/**
 * Poll until our server answers. The port was verified free right before we
 * spawned the server, so a 200/304 here is ours. If the spawned process dies
 * first, fail with its stderr tail instead of waiting for the timeout.
 */
function waitForServer(url, timeout = 180000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (nextExited) {
        const { code, signal } = nextExited;
        reject(
          new Error(
            `The local server exited early (code ${code}${signal ? `, signal ${signal}` : ""}).` +
              stderrSummary()
          )
        );
        return;
      }
      const req = http.get(url, (res) => {
        res.resume();
        if (res.statusCode === 200 || res.statusCode === 304) {
          resolve();
        } else {
          retry();
        }
      });
      req.setTimeout(5000, () => req.destroy(new Error("timeout")));
      req.on("error", retry);
    };
    const retry = () => {
      if (Date.now() - start > timeout) {
        reject(new Error(`Server did not start in time on port ${PORT}.` + stderrSummary()));
      } else {
        setTimeout(check, 500);
      }
    };
    check();
  });
}

function startNextServer() {
  const ROOT = getAppRoot();
  const bootstrap = getBootstrapEnv();
  const serverEnv = {
    ...process.env,
    ...bootstrap,
    NODE_ENV: isProd ? "production" : "development",
    ELECTRON_APP: "1",
    ELECTRON_RUN_AS_NODE: "1",
    PORT: String(PORT),
    HOSTNAME: "127.0.0.1",
  };

  // stdout is inherited in dev so Next's output lands in the terminal; stderr is
  // always piped so we can show its tail if the server dies.
  const spawnOpts = {
    env: serverEnv,
    stdio: ["ignore", app.isPackaged ? "pipe" : "inherit", "pipe"],
    windowsHide: true,
    // A process group on POSIX lets killServer() take the whole tree down.
    detached: process.platform !== "win32",
  };

  if (usesStandaloneServer()) {
    const standaloneDir = getStandaloneDir();
    const serverJs = getStandaloneServer();
    nextProcess = spawn(process.execPath, [serverJs], { ...spawnOpts, cwd: standaloneDir });
  } else {
    const nextBin = getNextBin();
    if (!fs.existsSync(nextBin)) {
      throw new Error("Next.js not found. Run npm install in the project folder.");
    }
    const args = isProd
      ? ["start", "-p", String(PORT), "--hostname", "127.0.0.1"]
      : ["dev", "-p", String(PORT), "--hostname", "127.0.0.1"];
    nextProcess = spawn(process.execPath, [nextBin, ...args], { ...spawnOpts, cwd: ROOT });
  }
  nextExited = null;

  if (nextProcess.stdout) {
    nextProcess.stdout.on("data", (d) => process.stdout.write(d));
  }
  nextProcess.stderr?.on("data", (d) => {
    rememberStderr(d);
    process.stderr.write(d);
  });

  nextProcess.on("error", (err) => {
    nextExited = { code: null, signal: null };
    if (app.isQuitting) return;
    dialog.showErrorBox("Failed to start app server", err.message + stderrSummary());
    app.quit();
  });

  nextProcess.on("exit", (code, signal) => {
    nextExited = { code, signal };
    // While starting, waitForServer reports the failure (with the stderr tail).
    if (serverReady && code !== null && code !== 0 && !app.isQuitting) {
      dialog.showErrorBox(
        "App server stopped",
        `The local server exited with code ${code}.` + stderrSummary()
      );
      app.quit();
    }
  });
}

function createWindow() {
  Menu.setApplicationMenu(null);

  const ROOT = getAppRoot();
  const appUrl = `http://127.0.0.1:${PORT}`;

  // Latte chrome — match the app shell instead of the default dark Windows title bar
  const chromeBg = "#cfc0ad";
  const chromeFg = "#2a241e";

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 700,
    minHeight: 560,
    title: "What About This Book?",
    backgroundColor: chromeBg,
    icon: (() => {
      const candidates = [
        path.join(ROOT, "public", "icon.png"),
        path.join(getStandaloneDir(), "public", "icon.png"),
        path.join(getAppRoot(), "public", "icon.png"),
      ];
      return candidates.find((p) => fs.existsSync(p)) || candidates[0];
    })(),
    autoHideMenuBar: true,
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: chromeBg,
      symbolColor: chromeFg,
      height: 36,
    },
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
    show: false,
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  mainWindow.webContents.on("will-navigate", (event, url) => {
    const allowed = url.startsWith(appUrl) || url.startsWith(`http://localhost:${PORT}`);
    if (!allowed) event.preventDefault();
  });

  mainWindow.loadURL(appUrl);

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
    mainWindow.focus();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

async function startApp() {
  const ROOT = getAppRoot();

  if (!isProd && !fs.existsSync(path.join(ROOT, "node_modules"))) {
    dialog.showErrorBox(
      "Setup required",
      "Run npm install in the project folder, then start the app again."
    );
    app.quit();
    return;
  }

  if (isProd && !usesStandaloneServer() && !fs.existsSync(path.join(ROOT, ".next"))) {
    dialog.showErrorBox(
      "Build missing",
      "The application was not built correctly. Reinstall from the installer."
    );
    app.quit();
    return;
  }

  if (isProd && app.isPackaged && !fs.existsSync(getStandaloneServer())) {
    dialog.showErrorBox(
      "Build missing",
      "Standalone server files are missing. Rebuild with: npm run dist"
    );
    app.quit();
    return;
  }

  if (app.isPackaged) {
    const envFile = path.join(os.homedir(), ".whataboutthisbook", ".env");
    if (!loadEnvFile(envFile).AWS_PROFILE && !process.env.AWS_PROFILE) {
      dialog.showMessageBox({
        type: "info",
        title: "AWS setup",
        message: "Configure AWS for Bedrock",
        detail:
          `Edit your AWS settings file:\n\n${envFile}\n\n` +
          "Set AWS_PROFILE to your SSO profile, then sign in with:\naws sso login --profile <name>",
      });
    }
  }

  PORT = await pickPort();
  if (PORT !== PREFERRED_PORT) {
    console.log(`Port ${PREFERRED_PORT} is busy; using ${PORT}.`);
  }
  startNextServer();

  await waitForServer(`http://127.0.0.1:${PORT}`);
  serverReady = true;

  // Warm AWS SSO on startup (opens browser only if session expired)
  http
    .get(`http://127.0.0.1:${PORT}/api/aws-status`, (res) => {
      res.resume();
    })
    .on("error", () => {});

  createWindow();
}

function failAndQuit(title, error) {
  app.isQuitting = true;
  killServer();
  const message = error instanceof Error ? error.message : String(error);
  try {
    dialog.showErrorBox(title, message);
  } catch {
    console.error(`${title}: ${message}`);
  }
  app.quit();
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    try {
      await startApp();
    } catch (error) {
      failAndQuit("Could not start", error);
    }
  });

  app.on("window-all-closed", () => {
    app.isQuitting = true;
    killServer();
    app.quit();
  });

  app.on("before-quit", () => {
    app.isQuitting = true;
    killServer();
  });

  app.on("will-quit", () => {
    killServer();
  });

  process.on("exit", () => {
    killServer();
  });

  process.on("uncaughtException", (error) => {
    failAndQuit("Unexpected error", error);
  });

  process.on("unhandledRejection", (reason) => {
    failAndQuit("Unexpected error", reason);
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
}

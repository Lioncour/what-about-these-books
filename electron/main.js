const { app, BrowserWindow, Menu, dialog } = require("electron");
const { spawn } = require("child_process");
const path = require("path");
const http = require("http");
const fs = require("fs");
const os = require("os");

const PORT = Number(process.env.PORT) || 3000;
const isProd = app.isPackaged || process.env.NODE_ENV === "production";

let mainWindow;
let nextProcess;

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

function waitForServer(url, timeout = 180000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      http
        .get(url, (res) => {
          if (res.statusCode === 200 || res.statusCode === 304) {
            resolve();
          } else {
            retry();
          }
        })
        .on("error", retry);
    };
    const retry = () => {
      if (Date.now() - start > timeout) {
        reject(new Error("Server did not start in time"));
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

  if (usesStandaloneServer()) {
    const standaloneDir = getStandaloneDir();
    const serverJs = getStandaloneServer();
    nextProcess = spawn(process.execPath, [serverJs], {
      cwd: standaloneDir,
      env: serverEnv,
      stdio: app.isPackaged ? "pipe" : "inherit",
      windowsHide: true,
    });
  } else {
    const nextBin = getNextBin();
    if (!fs.existsSync(nextBin)) {
      throw new Error("Next.js not found. Run npm install in the project folder.");
    }
    const args = isProd
      ? ["start", "-p", String(PORT), "--hostname", "127.0.0.1"]
      : ["dev", "-p", String(PORT), "--hostname", "127.0.0.1"];
    nextProcess = spawn(process.execPath, [nextBin, ...args], {
      cwd: ROOT,
      env: serverEnv,
      stdio: app.isPackaged ? "pipe" : "inherit",
      windowsHide: true,
    });
  }

  if (app.isPackaged && nextProcess.stdout) {
    nextProcess.stdout.on("data", (d) => process.stdout.write(d));
    nextProcess.stderr?.on("data", (d) => process.stderr.write(d));
  }

  nextProcess.on("error", (err) => {
    dialog.showErrorBox("Failed to start app server", err.message);
    app.quit();
  });

  nextProcess.on("exit", (code) => {
    if (code !== null && code !== 0 && !app.isQuitting) {
      dialog.showErrorBox(
        "App server stopped",
        `The local server exited with code ${code}.`
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

  startNextServer();

  try {
    await waitForServer(`http://127.0.0.1:${PORT}`);
  } catch (error) {
    dialog.showErrorBox(
      "Could not start",
      error instanceof Error ? error.message : String(error)
    );
    app.quit();
    return;
  }

  // Warm AWS SSO on startup (opens browser only if session expired)
  http
    .get(`http://127.0.0.1:${PORT}/api/aws-status`, (res) => {
      res.resume();
    })
    .on("error", () => {});

  createWindow();
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

  app.whenReady().then(startApp);

  app.on("window-all-closed", () => {
    app.isQuitting = true;
    if (nextProcess) nextProcess.kill();
    app.quit();
  });

  app.on("before-quit", () => {
    app.isQuitting = true;
    if (nextProcess) nextProcess.kill();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
}

const { app, BrowserWindow, Menu, dialog } = require("electron");
const { spawn } = require("child_process");
const path = require("path");
const http = require("http");

const DEV = process.env.NODE_ENV !== "production";
const PORT = 3000;
let mainWindow;
let nextProcess;

function waitForServer(url, timeout = 30000) {
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

function createWindow() {
  Menu.setApplicationMenu(null);

  mainWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    minWidth: 600,
    minHeight: 500,
    title: "What About This Book?",
    icon: path.join(__dirname, "..", "public", "icon.png"),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
    show: false,
  });

  mainWindow.loadURL(`http://localhost:${PORT}`);

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

async function startApp() {
  if (DEV) {
    await waitForServer(`http://localhost:${PORT}`).catch(() => {
      dialog.showErrorBox(
        "Dev server not running",
        "Please start the Next.js dev server first:\n\nnpm run dev"
      );
      app.quit();
    });
  } else {
    const nextBin = path.join(__dirname, "..", "node_modules", ".bin", "next");
    nextProcess = spawn(nextBin, ["start", "-p", String(PORT)], {
      cwd: path.join(__dirname, ".."),
      shell: true,
      env: { ...process.env, NODE_ENV: "production" },
    });

    nextProcess.stdout.on("data", (d) => process.stdout.write(d));
    nextProcess.stderr.on("data", (d) => process.stderr.write(d));

    await waitForServer(`http://localhost:${PORT}`);
  }

  createWindow();
}

app.whenReady().then(startApp);

app.on("window-all-closed", () => {
  if (nextProcess) nextProcess.kill();
  app.quit();
});

app.on("before-quit", () => {
  if (nextProcess) nextProcess.kill();
});

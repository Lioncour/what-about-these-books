// Turns Next's `.next/standalone` output into what the desktop app ships and runs:
// adds the static assets and `public`, and removes everything the server doesn't need.
//
// Next traces file reads that start at the project root (the eval harness, for one), so
// the standalone folder otherwise contains the whole project: sources, tests, docs and,
// worst, `.env` / `.env.local`. Those must never end up in an installer.

import fs from "fs";
import path from "path";

const root = process.cwd();
const standaloneDir = path.join(root, ".next", "standalone");
const staticSrc = path.join(root, ".next", "static");
const staticDest = path.join(standaloneDir, ".next", "static");
const publicSrc = path.join(root, "public");
const publicDest = path.join(standaloneDir, "public");

if (!fs.existsSync(standaloneDir)) {
  console.error("Missing .next/standalone — run next build with output: 'standalone' first.");
  process.exit(1);
}

if (fs.existsSync(staticSrc)) {
  fs.cpSync(staticSrc, staticDest, { recursive: true });
  console.log("Copied .next/static into standalone");
}

if (fs.existsSync(publicSrc)) {
  fs.cpSync(publicSrc, publicDest, { recursive: true });
  console.log("Copied public into standalone");
}

// Next 16 (Turbopack build) leaves the route-handler runtime out of the trace: the
// standalone output has app-page-turbo but not app-route-turbo, so every /api route
// fails with "Cannot find module" once the folder leaves the project (inside it, Node
// quietly finds the file in the project's own node_modules). Copy all server runtimes.
const runtimeSrc = path.join(root, "node_modules", "next", "dist", "compiled", "next-server");
const runtimeDest = path.join(standaloneDir, "node_modules", "next", "dist", "compiled", "next-server");
if (fs.existsSync(runtimeSrc) && fs.existsSync(runtimeDest)) {
  const added = [];
  for (const file of fs.readdirSync(runtimeSrc)) {
    if (!/\.runtime\.prod\.js$/.test(file)) continue;
    if (fs.existsSync(path.join(runtimeDest, file))) continue;
    fs.copyFileSync(path.join(runtimeSrc, file), path.join(runtimeDest, file));
    added.push(file);
  }
  if (added.length) console.log(`Added Next server runtimes the trace missed: ${added.join(", ")}`);
}

// The only things the standalone server needs at its top level.
const KEEP = new Set(["server.js", "package.json", "node_modules", ".next", "public"]);
const removed = [];
for (const entry of fs.readdirSync(standaloneDir)) {
  if (KEEP.has(entry)) continue;
  fs.rmSync(path.join(standaloneDir, entry), { recursive: true, force: true });
  removed.push(entry);
}
if (removed.length) console.log(`Removed from standalone: ${removed.join(", ")}`);

// Belt and braces: an env file anywhere in what ships is a build failure, not a warning.
const leaked = [];
const walk = (dir, depth) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth < 6) walk(full, depth + 1);
    } else if (/^\.env(\..*)?$/.test(entry.name) && entry.name !== ".env.example") {
      leaked.push(path.relative(standaloneDir, full));
    }
  }
};
walk(standaloneDir, 0);
if (leaked.length) {
  console.error(`Env files in the standalone output: ${leaked.join(", ")}. Refusing to continue.`);
  process.exit(1);
}

for (const needed of [
  "server.js",
  "node_modules/next/package.json",
  "node_modules/next/dist/compiled/next-server/app-route-turbo.runtime.prod.js",
  ".next/BUILD_ID",
]) {
  if (!fs.existsSync(path.join(standaloneDir, needed))) {
    console.error(`Standalone output is incomplete: missing ${needed}`);
    process.exit(1);
  }
}
console.log("Standalone output is ready to ship");

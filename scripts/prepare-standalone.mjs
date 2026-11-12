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

// Packages listed in `serverExternalPackages` (vectra, epub2) are not bundled. The build
// leaves a link for each in `.next/node_modules/<name>-<hash>` that points into the
// project's own node_modules (an absolute path on Windows), and traces their
// dependencies only partly (`uuid` arrives as a bare package.json). That works on the
// machine that built it and nowhere else. Replace each link with a real copy and bring
// the package's whole production dependency tree into the standalone node_modules.
const projectModules = path.join(root, "node_modules");
const standaloneModules = path.join(standaloneDir, "node_modules");
const linkDir = path.join(standaloneDir, ".next", "node_modules");

const readPackage = (dir) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  } catch {
    return null;
  }
};
const copyReal = (from, to) => {
  fs.rmSync(to, { recursive: true, force: true });
  fs.cpSync(from, to, { recursive: true, dereference: true });
};

/** Copy a root-level package and, transitively, every root-level package it depends on. */
function shipWithDependencies(startNames) {
  const done = new Set();
  const queue = [...startNames];
  while (queue.length) {
    const name = queue.shift();
    if (done.has(name)) continue;
    done.add(name);
    const from = path.join(projectModules, name);
    const pkg = readPackage(from);
    if (!pkg) continue; // optional dependency that isn't installed on this platform
    copyReal(from, path.join(standaloneModules, name));
    for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })) {
      // A dependency nested inside the package came along with the copy.
      if (fs.existsSync(path.join(from, "node_modules", dep, "package.json"))) continue;
      queue.push(dep);
    }
  }
  return done;
}

if (fs.existsSync(linkDir)) {
  const externals = [];
  for (const entry of fs.readdirSync(linkDir)) {
    const linkPath = path.join(linkDir, entry);
    const name = readPackage(linkPath)?.name || entry.replace(/-[0-9a-f]{8,}$/, "");
    const source = path.join(projectModules, name);
    if (!readPackage(source)) {
      console.error(`External package ${name} (${entry}) is not installed; cannot ship it.`);
      process.exit(1);
    }
    copyReal(source, linkPath);
    externals.push(name);
  }
  const shipped = shipWithDependencies(externals);
  console.log(`Shipped external packages ${externals.join(", ")} with ${shipped.size - externals.length} dependencies`);
}

// Nothing in what ships may point outside it.
const links = [];
const findLinks = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (fs.lstatSync(full).isSymbolicLink()) links.push(path.relative(standaloneDir, full));
    else if (entry.isDirectory()) findLinks(full);
  }
};
findLinks(standaloneDir);
if (links.length) {
  console.error(`Links left in the standalone output: ${links.slice(0, 10).join(", ")}. Refusing to continue.`);
  process.exit(1);
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
  "node_modules/vectra/package.json",
  "node_modules/uuid/dist/cjs/index.js",
  ".next/BUILD_ID",
]) {
  if (!fs.existsSync(path.join(standaloneDir, needed))) {
    console.error(`Standalone output is incomplete: missing ${needed}`);
    process.exit(1);
  }
}
console.log("Standalone output is ready to ship");

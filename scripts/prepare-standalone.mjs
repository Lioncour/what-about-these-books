// Turns Next's `.next/standalone` output into what the desktop app ships and runs:
// adds the static assets and `public`, and removes everything the server doesn't need.
//
// Next traces file reads that start at the project root (the eval harness, for one), so
// the standalone folder otherwise contains the whole project: sources, tests, docs and,
// worst, `.env` / `.env.local`. Those must never end up in an installer.

import fs from "fs";
import path from "path";
import { copyReachable, packageOfFile, reachableFiles, resolveFrom } from "./standalone-deps.mjs";

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
// machine that built it and nowhere else. Replace each link with real files, and bring
// along exactly what those packages can load: a walk over `require`/`import` from the
// modules the server asks for (scripts/standalone-deps.mjs), not the packages' whole
// dependency trees, which are mostly an OpenAI client, a web scraper and a CLI.
// `node scripts/trace-server-modules.mjs` shows what the running server really loads.
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
const fail = (message) => {
  console.error(message);
  process.exit(1);
};

/** Every `require("<link>")` / `require("<link>/sub/path.js")` in the server's code. */
function requestedPaths(linkName) {
  const found = new Set();
  // Link names are a package name and a hash: letters, digits, dots, dashes, underscores.
  const escaped = linkName.replace(/[^\w-]/g, (ch) => "\\" + ch);
  const pattern = new RegExp("[\"'`]" + escaped + "(/[^\"'`]*)?[\"'`]", "g");
  const scan = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") scan(full);
      } else if (/\.(c|m)?js$/.test(entry.name)) {
        for (const match of fs.readFileSync(full, "utf8").matchAll(pattern)) found.add(match[1] || "");
      }
    }
  };
  scan(path.join(standaloneDir, ".next", "server"));
  return [...found];
}

const shippedExternals = [];
if (fs.existsSync(linkDir)) {
  const externals = []; // { name, link }
  const entries = [];
  for (const entry of fs.readdirSync(linkDir)) {
    const linkPath = path.join(linkDir, entry);
    const name = readPackage(linkPath)?.name || entry.replace(/-[0-9a-f]{8,}$/, "");
    if (!readPackage(path.join(projectModules, name))) {
      fail(`External package ${name} (${entry}) is not installed; cannot ship it.`);
    }
    const subpaths = requestedPaths(entry);
    // Nothing found means the build changed how it names externals: ship the package's
    // main module rather than guess.
    for (const sub of subpaths.length ? subpaths : [""]) {
      try {
        entries.push(resolveFrom(root, name + sub));
      } catch {
        fail(`The server requires ${name}${sub}, which does not resolve in node_modules.`);
      }
    }
    externals.push({ name, link: linkPath, subpaths });
  }

  const reach = reachableFiles(entries);
  // Start clean: whatever the build traced for these packages is replaced, not merged.
  for (const file of reach.files) {
    const pkg = packageOfFile(file);
    const top = path.relative(projectModules, pkg.dir).split(path.sep);
    const topDir = path.join(standaloneModules, top[0].startsWith("@") ? path.join(top[0], top[1]) : top[0]);
    if (fs.existsSync(topDir)) fs.rmSync(topDir, { recursive: true, force: true });
  }
  const packages = copyReachable(reach, projectModules, standaloneModules);
  for (const { name, link } of externals) {
    fs.rmSync(link, { recursive: true, force: true });
    fs.cpSync(path.join(standaloneModules, name), link, { recursive: true });
    shippedExternals.push(name);
  }
  const bytes = [...reach.files].reduce((n, f) => n + fs.statSync(f).size, 0);
  console.log(
    `Shipped external packages ${externals.map((e) => `${e.name}${e.subpaths.filter(Boolean).join(",")}`).join(", ")} ` +
      `with what they load: ${reach.files.size} files from ${packages.length} packages (${(bytes / 1048576).toFixed(1)} MB)`
  );
  for (const [dir, reason] of reach.whole) console.log(`  whole package: ${path.relative(projectModules, dir)} (${reason})`);
  for (const { from, spec } of reach.unresolved) {
    console.log(`  not installed, so not shipped: "${spec}" asked for by ${path.relative(projectModules, from)}`);
  }
}

// Traced by the build, never loaded by the server: the TypeScript compiler (next.config.ts
// is compiled at build time), type declarations, and sharp, which only serves next/image
// and this app renders no optimised images (`images.unoptimized` in next.config.ts).
const dropped = [];
for (const name of ["typescript", "@types", "sharp", "@img", "detect-libc"]) {
  const dir = path.join(standaloneModules, name);
  if (!fs.existsSync(dir)) continue;
  fs.rmSync(dir, { recursive: true, force: true });
  dropped.push(name);
}
if (dropped.length) console.log(`Removed build-only packages: ${dropped.join(", ")}`);

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
  "node_modules/uuid/dist/cjs/index.js",
  ".next/BUILD_ID",
  ...shippedExternals.map((name) => `node_modules/${name}/package.json`),
]) {
  if (!fs.existsSync(path.join(standaloneDir, needed))) {
    console.error(`Standalone output is incomplete: missing ${needed}`);
    process.exit(1);
  }
}
console.log("Standalone output is ready to ship");

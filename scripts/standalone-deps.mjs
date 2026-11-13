// Finds the files a set of entry modules can reach, by reading their `require(...)` and
// `import` statements and resolving each the way Node would. Used by
// prepare-standalone.mjs to ship only what the unbundled packages (vectra, epub2) really
// load, instead of their whole dependency trees.
//
// It errs on the side of shipping more: text in comments counts, requires inside
// functions count, and a package that builds a module path at run time, or reads files
// next to its own code, is shipped whole.

import fs from "fs";
import { createRequire, isBuiltin } from "module";
import path from "path";

const SOURCE = /\.(c|m)?js$/;
const LITERAL_PATTERNS = [
  /\brequire\s*\(\s*(['"`])([^'"`\n]+)\1\s*\)/g,
  /\bimport\s*\(\s*(['"`])([^'"`\n]+)\1\s*\)/g,
  /\b(?:import|export)\s+(?:[^'"();]*?\s+from\s+)?(['"])([^'"\n]+)\1/g,
];
// `require(name)`, `require("./x/" + name)`, `require(`./${name}`)`: a path made at run time.
const COMPUTED_REQUIRE = /\b(?:require|import)\s*\(\s*(?:[A-Za-z_$][\w$.]*\s*[),+]|['"][^'"\n]*['"]\s*\+|`[^`\n]*\$\{)/;
const READS_OWN_FILES = /\b(?:__dirname|__filename|import\.meta\.url)\b[\s\S]{0,400}\b(?:readFileSync|readFile|readdirSync|readdir|createReadStream)\b|\b(?:readFileSync|readFile|readdirSync|readdir|createReadStream)\b[\s\S]{0,400}\b(?:__dirname|__filename|import\.meta\.url)\b/;

/** The package a file under node_modules belongs to: its folder and name. */
export function packageOfFile(file) {
  const parts = file.split(path.sep);
  const at = parts.lastIndexOf("node_modules");
  if (at === -1) return null;
  const scoped = parts[at + 1]?.startsWith("@");
  const name = scoped ? `${parts[at + 1]}/${parts[at + 2]}` : parts[at + 1];
  return { name, dir: parts.slice(0, at + (scoped ? 3 : 2)).join(path.sep) };
}

/**
 * Follow requires and imports from `entryFiles` (absolute paths).
 * Returns the files reached, the packages that must ship whole (with the reason), and the
 * specifiers that did not resolve (optional requires, as a rule: `try { require("x") }`).
 */
export function reachableFiles(entryFiles) {
  const files = new Set();
  const whole = new Map(); // package dir -> reason
  const unresolved = [];
  const queue = [...entryFiles];
  while (queue.length) {
    const file = queue.pop();
    if (files.has(file)) continue;
    files.add(file);
    if (!SOURCE.test(file)) continue; // .json and .node files load nothing further
    const source = fs.readFileSync(file, "utf8");
    const pkg = packageOfFile(file);
    if (pkg && !whole.has(pkg.dir)) {
      if (COMPUTED_REQUIRE.test(source)) whole.set(pkg.dir, `computed require in ${path.relative(pkg.dir, file)}`);
      else if (READS_OWN_FILES.test(source)) whole.set(pkg.dir, `reads its own files in ${path.relative(pkg.dir, file)}`);
    }
    const resolver = createRequire(file);
    for (const pattern of LITERAL_PATTERNS) {
      for (const match of source.matchAll(pattern)) {
        const spec = match[2];
        // "node:x" is always a builtin, also one this Node version doesn't have yet.
        if (spec.includes("${") || isBuiltin(spec) || spec.startsWith("node:")) continue;
        let found;
        try {
          found = resolver.resolve(spec);
        } catch {
          if (!unresolved.some((u) => u.from === file && u.spec === spec)) unresolved.push({ from: file, spec });
          continue;
        }
        if (path.isAbsolute(found)) queue.push(found);
      }
    }
  }
  return { files, whole, unresolved };
}

/** What Node loads for `specifier` when required from `fromDir`. */
export function resolveFrom(fromDir, specifier) {
  return createRequire(path.join(fromDir, "noop.js")).resolve(specifier);
}

const SKIP_IN_WHOLE = /\.(map|d\.ts|d\.mts|d\.cts|md|markdown)$/i;
const ALWAYS = /^(package\.json|licen[cs]e(\..*)?|notice(\..*)?|copying(\..*)?)$/i;

/**
 * Copy what `reachableFiles` found from `fromModules` (a node_modules folder) into
 * `toModules`, keeping the layout: every reached file, each package's package.json and
 * licence, and all of a package that must ship whole (minus maps, typings and its nested
 * node_modules, which arrive file by file like everything else).
 * Returns the package names copied.
 */
export function copyReachable({ files, whole }, fromModules, toModules) {
  const packages = new Map(); // dir -> name
  const copyFile = (file) => {
    const target = path.join(toModules, path.relative(fromModules, file));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(file, target);
  };
  for (const file of files) {
    if (!file.startsWith(fromModules + path.sep)) {
      throw new Error(`Reached a file outside node_modules: ${file}`);
    }
    const pkg = packageOfFile(file);
    packages.set(pkg.dir, pkg.name);
    copyFile(file);
    // `package.json` files between the file and its package root decide how Node reads it
    // (uuid's dist/cjs/package.json says "commonjs").
    for (let dir = path.dirname(file); dir.startsWith(pkg.dir) && dir !== pkg.dir; dir = path.dirname(dir)) {
      const marker = path.join(dir, "package.json");
      if (fs.existsSync(marker)) copyFile(marker);
    }
  }
  for (const dir of packages.keys()) {
    for (const entry of fs.readdirSync(dir)) {
      if (ALWAYS.test(entry) && fs.statSync(path.join(dir, entry)).isFile()) copyFile(path.join(dir, entry));
    }
    if (!whole.has(dir)) continue;
    fs.cpSync(dir, path.join(toModules, path.relative(fromModules, dir)), {
      recursive: true,
      dereference: true,
      filter: (src) => {
        if (src === dir) return true;
        if (path.basename(src) === "node_modules") return false;
        return fs.statSync(src).isDirectory() || !SKIP_IN_WHOLE.test(src);
      },
    });
  }
  return [...new Set(packages.values())].sort();
}

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import * as vectraPackage from "vectra";
import { LocalDocumentIndex } from "vectra/lib/LocalDocumentIndex";
import { sampleEpub } from "../scripts/sample-books.mjs";
import { copyReachable, packageOfFile, reachableFiles, resolveFrom } from "../scripts/standalone-deps.mjs";

/**
 * What the installer ships of vectra and epub2 is decided by a walk over their requires
 * (scripts/standalone-deps.mjs). These tests hold that walk to its promise: the app's
 * narrow import reads an index the full package wrote, and the pruned copy works on its
 * own, outside the project, for indexing, querying and EPUB parsing.
 */

const root = join(__dirname, "..");
const temps: string[] = [];
const temp = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

/** Deterministic stand-in for Bedrock: words hashed into a small normalised vector. */
const fakeEmbeddings = {
  maxTokens: 8192,
  async createEmbeddings(inputs: string | string[]) {
    const output = (Array.isArray(inputs) ? inputs : [inputs]).map((text) => {
      const vector = new Array(48).fill(0);
      for (const word of text.toLowerCase().match(/[a-z]+/g) || []) {
        let h = 0;
        for (const ch of word) h = (h * 31 + ch.charCodeAt(0)) % 48;
        vector[h] += 1;
      }
      const norm = Math.sqrt(vector.reduce((n, v) => n + v * v, 0)) || 1;
      return vector.map((v) => v / norm);
    });
    return { status: "success" as const, output };
  },
};
const CHUNKING = { chunkSize: 512, chunkOverlap: 64 };
const BOOKS: Array<[string, string]> = [
  ["book-1", "The lighthouse keeper counted the ships every evening and wrote the tide in a ledger."],
  ["book-2", "A baker in the mountain village kneaded dough before dawn and sold bread at the market."],
];

function entryFiles(): string[] {
  return [resolveFrom(root, "vectra/lib/LocalDocumentIndex.js"), resolveFrom(root, "epub2")];
}
const packageNames = (files: Iterable<string>) => new Set([...files].map((f) => packageOfFile(f)?.name));

describe("vectra through the narrow import", () => {
  it("is the same class the package index exports", () => {
    expect(LocalDocumentIndex).toBe(vectraPackage.LocalDocumentIndex);
  });

  it("reads and queries an index written through the package index", async () => {
    const folderPath = join(temp("wabt-pack-index-"), "index");
    const writer = new vectraPackage.LocalDocumentIndex({ folderPath, embeddings: fakeEmbeddings, chunkingConfig: CHUNKING });
    await writer.createIndex({ version: 1 });
    for (const [id, text] of BOOKS) await writer.upsertDocument(id, text, "book", { title: id, bookId: id });
    expect(readdirSync(folderPath)).toEqual(expect.arrayContaining(["index.json", "catalog.json"]));

    // A new instance, the way the app opens the index after a restart.
    const reader = new LocalDocumentIndex({ folderPath, embeddings: fakeEmbeddings, chunkingConfig: CHUNKING });
    expect(await reader.isCatalogCreated()).toBe(true);
    const all = await reader.queryDocuments("ships and the tide", { maxDocuments: 10, maxChunks: 10 });
    expect(all[0].uri).toBe("book-1");
    const sections = await all[0].renderSections(2048, 1, true);
    expect(sections[0].text).toContain("lighthouse keeper");

    const filtered = await reader.queryDocuments("ships and the tide", {
      maxDocuments: 1,
      maxChunks: 10,
      filter: { bookId: { $eq: "book-2" } },
    });
    expect(filtered.map((d) => d.uri)).toEqual(["book-2"]);
  });
});

describe("what ships of the unbundled packages", () => {
  it("follows requires to what is used and leaves the rest of the dependency tree", () => {
    const { files } = reachableFiles(entryFiles());
    const names = packageNames(files);
    for (const needed of ["vectra", "uuid", "gpt-tokenizer", "wink-nlp", "wink-bm25-text-search", "wink-eng-lite-web-model", "epub2", "adm-zip", "xml2js", "sax", "bluebird"]) {
      expect(names, needed).toContain(needed);
    }
    for (const unused of ["openai", "axios", "cheerio", "turndown", "yargs", "dotenv", "undici"]) {
      expect(names, unused).not.toContain(unused);
    }
  });

  it("works from a pruned copy outside the project", () => {
    const sandbox = temp("wabt-pack-sandbox-");
    const modules = join(sandbox, "node_modules");
    mkdirSync(modules);
    const shipped = copyReachable(reachableFiles(entryFiles()), join(root, "node_modules"), modules);
    expect(shipped).toContain("vectra");
    expect(readdirSync(modules)).not.toContain("openai");

    writeFileSync(join(sandbox, "sample.epub"), sampleEpub());
    writeFileSync(
      join(sandbox, "run.cjs"),
      `const path = require("path");
const { LocalDocumentIndex } = require("vectra/lib/LocalDocumentIndex.js");
const EPub = require("epub2").default || require("epub2");
const embeddings = { maxTokens: 8192, createEmbeddings: async (inputs) => ({
  status: "success",
  output: [].concat(inputs).map((text) => { const v = new Array(48).fill(0); for (const ch of text) v[ch.charCodeAt(0) % 48] += 1; const n = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1; return v.map((x) => x / n); }),
}) };
(async () => {
  const index = new LocalDocumentIndex({ folderPath: path.join(__dirname, "index"), embeddings, chunkingConfig: { chunkSize: 512, chunkOverlap: 64 } });
  if (!(await index.isCatalogCreated())) await index.createIndex({ version: 1 });
  await index.upsertDocument("book-1", ${JSON.stringify(BOOKS[0][1])}, "book", { bookId: "book-1" });
  await index.upsertDocument("book-2", ${JSON.stringify(BOOKS[1][1])}, "book", { bookId: "book-2" });
  const found = await index.queryDocuments("ships and the tide", { maxDocuments: 1, maxChunks: 5, filter: { bookId: { $eq: "book-1" } } });
  const sections = await found[0].renderSections(2048, 1, true);
  await index.deleteDocument("book-2");
  const epub = await EPub.createAsync(path.join(__dirname, "sample.epub"));
  const chapter = await new Promise((resolve, reject) => epub.getChapter(epub.flow[0].id, (err, text) => (err ? reject(err) : resolve(text))));
  console.log(JSON.stringify({ uri: found[0].uri, text: sections[0].text, title: epub.metadata.title, author: epub.metadata.creator, chapter: chapter.length }));
})().catch((error) => { console.error(error); process.exit(1); });
`
    );
    const out = execFileSync(process.execPath, ["run.cjs"], { cwd: sandbox, encoding: "utf8", env: { ...process.env, NODE_PATH: "" } });
    const result = JSON.parse(out.trim().split(/\r?\n/).pop() || "{}");
    expect(result.uri).toBe("book-1");
    expect(result.text).toContain("lighthouse keeper");
    expect(result).toMatchObject({ title: "Trace Sample", author: "Nobody Atall" });
    expect(result.chapter).toBeGreaterThan(100);
  }, 60_000);
});

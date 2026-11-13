import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { freshDataDir, removeDataDir, writeLibrary } from "./store-env";

// Editing a book never touches the vector index; make sure a stray import can't reach Bedrock.
vi.mock("vectra/lib/LocalDocumentIndex", () => ({ LocalDocumentIndex: class {} }));
vi.mock("@/lib/bedrock-embeddings", () => ({ BedrockEmbeddings: class {} }));

let dir: string;
const readJson = (...parts: string[]) => JSON.parse(readFileSync(join(dir, ...parts), "utf-8"));

beforeEach(() => {
  dir = freshDataDir();
  writeLibrary(dir, [
    { id: "book-1", title: "Columbus Day (Expeditionary For", filename: "cd.epub", author: "Alanson, Craig" },
    { id: "book-2", title: "Paradise", filename: "p.epub" },
  ]);
  mkdirSync(join(dir, "chats"), { recursive: true });
  writeFileSync(
    join(dir, "chats", "chat-1.json"),
    JSON.stringify({ id: "chat-1", bookId: "book-1", bookTitle: "old", title: "t", messages: [], updatedAt: "x" })
  );
  mkdirSync(join(dir, "specialists"), { recursive: true });
  writeFileSync(
    join(dir, "specialists", "book-1.json"),
    JSON.stringify({ bookId: "book-1", bookTitle: "old", summary: "s", keyTopics: [], notableEntities: [], styleNotes: [], updatedAt: "x" })
  );
});
afterEach(() => removeDataDir(dir));

describe("updateBookMetadata", () => {
  it("renames the book and every cached copy of its title", async () => {
    const { updateSpecialistScorecard, listSpecialistScorecards } = await import("@/lib/quality-store");
    updateSpecialistScorecard({ bookId: "book-1", bookTitle: "old", confidence: "high", findingsCount: 2 });
    const { updateBookMetadata } = await import("@/lib/store/book-edit");

    const book = updateBookMetadata("book-1", { title: "  Columbus   Day " });
    expect(book).toMatchObject({ id: "book-1", title: "Columbus Day", author: "Alanson, Craig", filename: "cd.epub" });

    expect(readJson("books.json").books[0].title).toBe("Columbus Day");
    expect(readJson("specialists", "book-1.json").bookTitle).toBe("Columbus Day");
    expect(readJson("chats", "chat-1.json").bookTitle).toBe("Columbus Day");
    expect(listSpecialistScorecards().find((c) => c.bookId === "book-1")?.bookTitle).toBe("Columbus Day");
    expect(readdirSync(dir).filter((f) => f.includes(".tmp-"))).toEqual([]);
  });

  it("sets, trims and clears the author without touching the title", async () => {
    const { updateBookMetadata } = await import("@/lib/store/book-edit");
    expect(updateBookMetadata("book-2", { author: "  Craig   Alanson " }).author).toBe("Craig Alanson");
    expect(readJson("books.json").books[1]).toMatchObject({ title: "Paradise", author: "Craig Alanson" });

    const cleared = updateBookMetadata("book-2", { author: "" });
    expect(cleared.author).toBeUndefined();
    expect("author" in readJson("books.json").books[1]).toBe(false);
  });

  it("changes both at once and leaves a no-op alone", async () => {
    const { updateBookMetadata } = await import("@/lib/store/book-edit");
    expect(updateBookMetadata("book-1", { title: "Columbus Day", author: "Craig Alanson" })).toMatchObject({
      title: "Columbus Day",
      author: "Craig Alanson",
    });
    const before = readFileSync(join(dir, "books.json"), "utf-8");
    expect(updateBookMetadata("book-1", {})).toMatchObject({ title: "Columbus Day" });
    expect(updateBookMetadata("book-1", { title: "Columbus Day", author: "Craig Alanson" }).title).toBe("Columbus Day");
    expect(readFileSync(join(dir, "books.json"), "utf-8")).toBe(before);
  });

  it("refuses a title another book has, whatever the case or spacing", async () => {
    const { updateBookMetadata, BookEditError } = await import("@/lib/store/book-edit");
    let error: unknown;
    try {
      updateBookMetadata("book-1", { title: " paradise ", author: "Someone" });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(BookEditError);
    expect(error).toMatchObject({ status: 409, message: 'Another book is already called "Paradise"' });
    // Nothing was written, the author included.
    expect(readJson("books.json").books[0]).toMatchObject({ title: "Columbus Day (Expeditionary For", author: "Alanson, Craig" });
    // Its own title in another case is fine.
    expect(updateBookMetadata("book-2", { title: "PARADISE" }).title).toBe("PARADISE");
  });

  it.each([
    ["a malformed id", "../book-1", { title: "X" }],
    ["an unknown book", "book-999", { title: "X" }],
    ["an empty title", "book-1", { title: "   " }],
    ["a title that is not text", "book-1", { title: 42 }],
    ["a title over 200 characters", "book-1", { title: "x".repeat(201) }],
    ["an author over 120 characters", "book-1", { author: "x".repeat(121) }],
    ["an author that is not text", "book-1", { author: ["Craig"] }],
  ])("answers 400 for %s", async (_what, id, patch) => {
    const { updateBookMetadata } = await import("@/lib/store/book-edit");
    const before = readFileSync(join(dir, "books.json"), "utf-8");
    expect(() => updateBookMetadata(id, patch)).toThrowError(expect.objectContaining({ status: 400 }));
    expect(readFileSync(join(dir, "books.json"), "utf-8")).toBe(before);
  });

  it("accepts the longest allowed values", async () => {
    const { updateBookMetadata } = await import("@/lib/store/book-edit");
    const book = updateBookMetadata("book-1", { title: "t".repeat(200), author: "a".repeat(120) });
    expect(book.title).toHaveLength(200);
    expect(book.author).toHaveLength(120);
  });
});

describe("covers", () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([4, 0, 0, 0]), Buffer.from("WEBPVP8 ")]);

  it("tells the image type from the first bytes", async () => {
    const { detectImageType } = await import("@/lib/store/covers");
    expect(detectImageType(PNG)).toBe("image/png");
    expect(detectImageType(JPEG)).toBe("image/jpeg");
    expect(detectImageType(WEBP)).toBe("image/webp");
    expect(detectImageType(Buffer.from("GIF89a..."))).toBeNull();
    expect(detectImageType(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
    expect(detectImageType(Buffer.concat([Buffer.from("RIFF"), Buffer.from([4, 0, 0, 0]), Buffer.from("WAVE")]))).toBeNull();
    expect(detectImageType(Buffer.alloc(0))).toBeNull();
  });

  it("replaces a cover whatever type the old one had and marks the book", async () => {
    const { replaceCover, getCoverPath } = await import("@/lib/store/covers");
    expect(replaceCover("book-1", JPEG)).toEqual({ ok: true });
    expect(getCoverPath("book-1")).toBe(join(dir, "covers", "book-1.jpg"));
    expect(readJson("books.json").books[0].hasCover).toBe(true);

    expect(replaceCover("book-1", WEBP)).toEqual({ ok: true });
    // The .jpg is gone: it would otherwise win the lookup and show the old cover.
    expect(readdirSync(join(dir, "covers"))).toEqual(["book-1.webp"]);
    expect(readFileSync(getCoverPath("book-1")!).equals(WEBP)).toBe(true);

    expect(replaceCover("book-1", PNG)).toEqual({ ok: true });
    expect(readdirSync(join(dir, "covers"))).toEqual(["book-1.png"]);
  });

  it("refuses what is not a PNG, JPEG or WebP, too large, or for no book", async () => {
    const { replaceCover, MAX_COVER_BYTES } = await import("@/lib/store/covers");
    expect(replaceCover("book-1", Buffer.from("GIF89a not allowed"))).toMatchObject({ ok: false, status: 400 });
    expect(replaceCover("book-1", Buffer.from("%PDF-1.7"))).toMatchObject({ ok: false, status: 400 });
    expect(replaceCover("book-1", Buffer.alloc(0))).toMatchObject({ ok: false, status: 400 });
    expect(replaceCover("book-1", Buffer.concat([PNG, Buffer.alloc(MAX_COVER_BYTES)]))).toMatchObject({
      ok: false,
      status: 400,
      error: "The cover can be at most 5 MB",
    });
    expect(replaceCover("../book-1", PNG)).toMatchObject({ ok: false, status: 400 });
    expect(replaceCover("book-999", PNG)).toMatchObject({ ok: false, status: 404 });
    expect(existsSync(join(dir, "covers", "book-1.png"))).toBe(false);
    expect(readJson("books.json").books[0].hasCover).toBeUndefined();
  });
});

describe("settings", () => {
  it("normalises whatever it is given, on save and on load", async () => {
    const { saveSettings, loadSettings, normalizeSettings } = await import("@/lib/store/settings");
    expect(loadSettings()).toEqual(normalizeSettings(null));
    expect(normalizeSettings(null)).toMatchObject({
      language: "Auto",
      tone: "Casual",
      answerMode: "Evidence-heavy",
      countMode: "whole_word",
      companionMode: true,
      useConversationMemory: true,
      groundedMode: false,
    });

    const saved = saveSettings({
      language: "Norwegian",
      answerMode: "Nonsense",
      countMode: "phrase",
      companionMode: false,
      useConversationMemory: "no",
      focusAreas: ["a", 2],
      modelRouting: { specialistModelId: "  eu.some-model ", orchestratorModelId: "", extractionModelId: 7 },
      modelRoutingStatus: { ignored: true },
      recheckModels: true,
    });
    expect(saved).toEqual({
      language: "Norwegian",
      tone: "Casual",
      customInstructions: "",
      focusAreas: ["a", "2"],
      groundedMode: false,
      answerMode: "Evidence-heavy",
      useConversationMemory: true,
      countMode: "phrase",
      companionMode: false,
      modelRouting: { specialistModelId: "eu.some-model", orchestratorModelId: undefined, extractionModelId: undefined },
    });
    expect(loadSettings()).toEqual(saved);
    expect(readJson("settings.json")).not.toHaveProperty("modelRoutingStatus");
  });
});

describe("model routing state", () => {
  it("is remembered on disk and forgotten on a re-check", async () => {
    const store = await import("@/lib/model-routing-store");
    expect(store.loadModelRoutingState()).toEqual({ models: {} });
    const state = { models: { "eu.cheap": { usable: false, checkedAt: "2026-11-12T10:00:00.000Z", reason: "denied" } } };
    store.saveModelRoutingState(state);
    expect(readJson("ops", "model-routing.json")).toMatchObject(state);
    expect(readdirSync(join(dir, "ops")).filter((f) => f.includes(".tmp-"))).toEqual([]);

    // A new process reads it back.
    vi.resetModules();
    const again = await import("@/lib/model-routing-store");
    expect(again.loadModelRoutingState()).toEqual(state);

    again.clearModelRoutingState();
    expect(again.loadModelRoutingState()).toEqual({ models: {} });
    expect(existsSync(join(dir, "ops", "model-routing.json"))).toBe(false);
  });

  it("starts empty when the file is damaged", async () => {
    mkdirSync(join(dir, "ops"), { recursive: true });
    writeFileSync(join(dir, "ops", "model-routing.json"), "{not json");
    const store = await import("@/lib/model-routing-store");
    expect(store.loadModelRoutingState()).toEqual({ models: {} });
  });
});

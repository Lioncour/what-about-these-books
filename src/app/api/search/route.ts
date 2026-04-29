import { NextRequest, NextResponse } from "next/server";
import { listBooks, searchAllBooksKeyword, searchBookKeyword, searchSeriesKeyword } from "@/lib/book-store";
import { deleteSavedSearch, listSavedSearches, saveSavedSearch } from "@/lib/ops-store";

function parsePageNumber(label?: string): number | null {
  if (!label) return null;
  const m = label.match(/(\d+)/);
  return m ? Number(m[1]) : null;
}

export async function GET(request: NextRequest) {
  const mode = request.nextUrl.searchParams.get("mode") || "search";
  if (mode === "saved") {
    return NextResponse.json({ saved: listSavedSearches() });
  }

  const q = (request.nextUrl.searchParams.get("q") || "").trim();
  const scope = request.nextUrl.searchParams.get("scope") || "all";
  const scopeId = request.nextUrl.searchParams.get("scopeId") || "";
  const exactPhrase = request.nextUrl.searchParams.get("exactPhrase") || "";
  const mustInclude = (request.nextUrl.searchParams.get("mustInclude") || "").split(",").filter(Boolean);
  const exclude = (request.nextUrl.searchParams.get("exclude") || "").split(",").filter(Boolean);
  const pageFrom = Number(request.nextUrl.searchParams.get("pageFrom") || 0);
  const pageTo = Number(request.nextUrl.searchParams.get("pageTo") || 0);

  const terms = [...q.split(/\s+/).filter((w) => w.length > 2), ...mustInclude];
  let rows: Array<{ bookTitle: string; label: string; snippet: string }> = [];
  if (scope === "book" && scopeId) {
    const book = listBooks().find((b) => b.id === scopeId);
    if (book) {
      rows = searchBookKeyword(scopeId, terms, 500).map((m) => ({ bookTitle: book.title, label: m.label, snippet: m.snippet }));
    }
  } else if (scope === "series" && scopeId) {
    rows = searchSeriesKeyword(scopeId, terms, 500).map((m) => ({ bookTitle: m.bookTitle, label: m.label, snippet: m.snippet }));
  } else {
    rows = searchAllBooksKeyword(terms, 700).map((m) => ({ bookTitle: m.bookTitle, label: m.label, snippet: m.snippet }));
  }

  const filtered = rows.filter((r) => {
    if (exactPhrase && !r.snippet.toLowerCase().includes(exactPhrase.toLowerCase())) return false;
    if (exclude.some((ex) => r.snippet.toLowerCase().includes(ex.toLowerCase()))) return false;
    const pageNo = parsePageNumber(r.label);
    if (pageFrom && pageNo && pageNo < pageFrom) return false;
    if (pageTo && pageNo && pageNo > pageTo) return false;
    return true;
  });

  return NextResponse.json({ results: filtered.slice(0, 300) });
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const saved = saveSavedSearch({
    id: body?.id ? String(body.id) : undefined,
    name: String(body?.name || "Saved search"),
    query: String(body?.query || ""),
    scope: body?.scope === "book" || body?.scope === "series" ? body.scope : "all",
    scopeId: body?.scopeId ? String(body.scopeId) : undefined,
    exactPhrase: body?.exactPhrase ? String(body.exactPhrase) : undefined,
    mustInclude: Array.isArray(body?.mustInclude) ? body.mustInclude.map(String) : [],
    exclude: Array.isArray(body?.exclude) ? body.exclude.map(String) : [],
    pageFrom: body?.pageFrom ? Number(body.pageFrom) : undefined,
    pageTo: body?.pageTo ? Number(body.pageTo) : undefined,
  });
  return NextResponse.json({ saved });
}

export async function DELETE(request: NextRequest) {
  const id = request.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  deleteSavedSearch(id);
  return NextResponse.json({ ok: true });
}

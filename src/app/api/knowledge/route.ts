import { NextRequest, NextResponse } from "next/server";
import { detectChronologyConflicts, getEntityGraph, getTimelineForBooks, queryEntityGraph } from "@/lib/knowledge-store";
import { listBooks, searchBookKeyword } from "@/lib/book-store";

function detectCrossBookContradictions(entity: string): string[] {
  const books = listBooks();
  const claims = books.map((book) => {
    const rows = searchBookKeyword(book.id, [entity], 120).map((r) => r.snippet.toLowerCase());
    const alive = rows.some((t) => /\balive\b|\bsurvived\b|\blives\b/.test(t));
    const dead = rows.some((t) => /\bdied\b|\bkilled\b|\bdead\b/.test(t));
    return { title: book.title, alive, dead };
  });
  const hasAlive = claims.some((c) => c.alive);
  const hasDead = claims.some((c) => c.dead);
  if (!hasAlive || !hasDead) return [];
  return [
    `Potential contradiction for "${entity}": some books contain "alive/survived" claims while others contain "dead/killed" claims.`,
    ...claims
      .filter((c) => c.alive || c.dead)
      .map((c) => `- ${c.title}: ${c.alive ? "alive-claim" : ""}${c.alive && c.dead ? " + " : ""}${c.dead ? "dead-claim" : ""}`),
  ];
}

export async function GET(request: NextRequest) {
  const mode = request.nextUrl.searchParams.get("mode") || "graph";
  const query = request.nextUrl.searchParams.get("q") || "";
  const bookIds = request.nextUrl.searchParams.get("bookIds")?.split(",").filter(Boolean);
  const character = request.nextUrl.searchParams.get("character") || "";

  if (mode === "character" && character.trim()) {
    const graph = queryEntityGraph(character.trim());
    const topNode = graph.nodes.find((n) => n.name.toLowerCase() === character.trim().toLowerCase()) || graph.nodes[0];
    if (!topNode) return NextResponse.json({ character: character.trim(), found: false });
    const snippets = listBooks()
      .flatMap((book) =>
        searchBookKeyword(book.id, [topNode.name], 4).map((m) => ({
          bookTitle: book.title,
          location: m.label,
          snippet: m.snippet,
        }))
      )
      .slice(0, 24);
    return NextResponse.json({
      character: topNode.name,
      found: true,
      type: topNode.type,
      mentions: topNode.mentions,
      books: topNode.books,
      relations: graph.edges.slice(0, 24),
      snippets,
    });
  }
  if (mode === "contradictions") {
    if (!query.trim()) return NextResponse.json({ contradictions: [] });
    return NextResponse.json({ contradictions: detectCrossBookContradictions(query.trim()) });
  }

  if (mode === "timeline") {
    return NextResponse.json({ events: getTimelineForBooks(bookIds) });
  }
  if (mode === "conflicts") {
    return NextResponse.json({ conflicts: detectChronologyConflicts(bookIds) });
  }
  if (query) {
    return NextResponse.json(queryEntityGraph(query));
  }
  return NextResponse.json(getEntityGraph());
}

import type { ChatContext } from "@/lib/chat/context";
import { ensureKnowledgeCurrent } from "@/lib/knowledge-rebuild";
import { detectChronologyConflicts, queryEntityGraph } from "@/lib/knowledge-store";

/** "Show the entity graph for X" — answered from the knowledge graph, not the text. */
export function entityGraphStep(ctx: ChatContext): boolean {
  const asked =
    ctx.route.kind === "entity_graph" || /entity graph|relationship graph|who is connected/i.test(ctx.question);
  if (!asked) return false;

  ensureKnowledgeCurrent();
  const graph = queryEntityGraph(ctx.question.replace(/entity graph|relationship graph/gi, "").trim());
  const lines = ["## Entity Graph Matches", "", `Nodes: ${graph.nodes.length}, Edges: ${graph.edges.length}`];
  for (const node of graph.nodes.slice(0, 20)) {
    lines.push(`- **${node.name}** (${node.type}) mentions: ${node.mentions}`);
  }
  ctx.emitAnswer(lines.join("\n"), { reason: "entity_graph" });
  return true;
}

/** "Any timeline conflicts?" — answered from the timeline heuristics. */
export function timelineConflictsStep(ctx: ChatContext): boolean {
  if (!/timeline conflict|chronology conflict|timeline issue/i.test(ctx.question)) return false;

  ensureKnowledgeCurrent();
  const conflicts = detectChronologyConflicts();
  const text = conflicts.length
    ? `## Timeline Conflicts\n\n${conflicts.map((c) => `- ${c}`).join("\n")}`
    : "## Timeline Conflicts\n\nNo obvious chronology conflicts detected.";
  ctx.emitAnswer(text, { reason: "timeline_conflict_check" });
  return true;
}

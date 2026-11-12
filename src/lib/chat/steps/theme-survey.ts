import { logChatEvent } from "@/lib/chat-debug";
import type { ChatContext } from "@/lib/chat/context";
import {
  dedupeSources,
  findPopCultureReferences,
  formatPopCultureAnswer,
  popCultureHitsToSources,
} from "@/lib/chat/theme-survey";

/** Theme surveys (pop culture / movies / books references) scanned from the stored text. */
export function themeSurveyStep(ctx: ChatContext): boolean {
  if (ctx.route.kind !== "theme_pop_culture") return false;

  ctx.announceScope();
  const hits = findPopCultureReferences({ bookId: ctx.bookId, maxHits: 10 });
  logChatEvent("theme_survey_answered", {
    bookId: ctx.bookId,
    kind: "pop_culture",
    hits: hits.length,
    labels: hits.map((h) => h.label),
  });
  ctx.emitAnswer(formatPopCultureAnswer(hits), { reason: "theme_survey_pop_culture", hits: hits.length });
  ctx.sendSources(dedupeSources(popCultureHitsToSources(hits)));
  return true;
}

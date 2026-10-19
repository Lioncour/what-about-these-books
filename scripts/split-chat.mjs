import fs from "fs";

const lines = fs.readFileSync("src/lib/chat/handler.ts", "utf8").split("\n");
const slice = (a, b) => lines.slice(a - 1, b).join("\n");

let intent = slice(69, 266);
intent =
  'import type { ChatMessage } from "@/lib/chat/types";\n\n' +
  intent.replace(/^function /gm, "export function ");
fs.writeFileSync("src/lib/chat/intent.ts", intent);

let spec = slice(268, 662);
spec = spec.replace(/async function callClaudeText[\s\S]*?^}\n\n/m, "");
spec =
  `import { callClaudeText, extractJsonObject } from "@/lib/bedrock-claude";
import { getEntityGraph } from "@/lib/knowledge-store";
import {
  queryBook,
  searchBookKeyword,
  loadBookSpecialistProfile,
} from "@/lib/book-store";
import {
  fingerprintQuestion,
  getCachedSpecialistAnswer,
  setCachedSpecialistAnswer,
  updateSpecialistScorecard,
} from "@/lib/quality-store";
import type {
  SpecialistAnswer,
  SpecialistFinding,
  StreamSpecialistReport,
} from "@/lib/chat/types";

` +
  spec
    .replace(/^function /gm, "export function ")
    .replace(/^async function /gm, "export async function ")
    .replace(/^interface /gm, "export interface ");
fs.writeFileSync("src/lib/chat/specialist.ts", spec);

let orch = slice(283, 361) + "\n\n" + slice(624, 662);
orch =
  `import { callClaudeText } from "@/lib/bedrock-claude";
import type { ChatMessage, SpecialistAnswer } from "@/lib/chat/types";
import { summarizeSpecialistDisagreement } from "@/lib/chat/specialist";

` +
  orch
    .replace(/^function /gm, "export function ")
    .replace(/^async function /gm, "export async function ");
fs.writeFileSync("src/lib/chat/orchestrator.ts", orch);

const header = `import { NextRequest } from "next/server";
import { DEFAULT_BEDROCK_MODEL_ID } from "@/lib/bedrock-client";
import {
  queryBook,
  queryAllBooks,
  querySeriesBooks,
  searchBookKeyword,
  searchAllBooksKeyword,
  searchSeriesKeyword,
  countAllBooksKeywordMentions,
  countBookKeywordMentions,
  countSeriesKeywordMentions,
  searchExactQuoteInBook,
  searchExactQuoteAllBooks,
  searchExactQuoteInSeries,
  listSeries,
  listBooks,
  loadSettings,
  getBookById,
} from "@/lib/book-store";
import { logChatEvent } from "@/lib/chat-debug";
import { detectChronologyConflicts, queryEntityGraph } from "@/lib/knowledge-store";
import { callClaudeText } from "@/lib/bedrock-claude";
import { getLibrarianName } from "@/lib/chat/constants";
import {
  selectBooksForLibrarySpecialists,
  selectBooksForSeriesSpecialists,
} from "@/lib/chat/specialist-limits";
import type { ChatMessage, ChatSource } from "@/lib/chat/types";
import {
  extractQuotedText,
  looksLikeQuoteLookup,
  extractMentionCountTarget,
  resolveCountTarget,
  looksLikeMentionCountQuestion,
  looksLikeMainCharacterQuestion,
  extractWhoIsTarget,
  shouldBypassSpecialists,
  extractRetryQuestion,
  looksLikeLibraryCountQuestion,
  looksLikeHaveYouReadQuestion,
  buildRecentConversation,
} from "@/lib/chat/intent";
import {
  deriveMainCharacters,
  askBookSpecialist,
  synthesizeWhoIsAnswer,
  toSpecialistReports,
} from "@/lib/chat/specialist";
import {
  looksLikeThinAnswer,
  orchestrateSpecialists,
  claudeNaturalAnswer,
} from "@/lib/chat/orchestrator";

export const maxDuration = 120;

`;

const bodyStart = lines.findIndex((l) => l.startsWith("export async function POST"));
const body = lines.slice(bodyStart).join("\n");
fs.writeFileSync("src/lib/chat/handler.ts", header + body);
console.log("handler lines", header.split("\n").length + body.split("\n").length);

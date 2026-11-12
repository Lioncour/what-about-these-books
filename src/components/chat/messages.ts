import type { Source } from "@/components/chat/MessageExtras";
import {
  normalizeScope,
  normalizeUsage,
  type ScopeInfo,
  type UsageInfo,
} from "@/components/chat/format";

export interface Message {
  role: "user" | "assistant";
  content: string;
  sources?: Source[];
  /** Books this answer was drawn from. */
  scope?: ScopeInfo;
  /** Calls, tokens and time this answer took. */
  usage?: UsageInfo;
}

export interface ChatSummary {
  id: string;
  bookId: string;
  bookTitle: string;
  title: string;
  updatedAt: string;
  /** Books picked by hand for this conversation (absent in older chats). */
  pickedIds?: string[];
}

/** The focus: a book, or a series as `{ id: "series:<id>", title: <series name> }`. */
export interface FocusBook {
  id: string;
  title: string;
}

/** What a message looks like in a saved chat: only the fields worth keeping. */
export function toSavedMessage(m: Message): Message {
  return {
    role: m.role,
    content: m.content,
    ...(m.sources?.length ? { sources: m.sources } : {}),
    ...(m.scope ? { scope: m.scope } : {}),
    ...(m.usage ? { usage: m.usage } : {}),
  };
}

/** Read saved messages back; chats saved before scope/usage existed still load. */
export function fromSavedMessages(raw: unknown): Message[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((m): m is Record<string, unknown> => !!m && typeof m === "object")
    .map((m) => {
      const scope = normalizeScope(m.scope);
      const usage = normalizeUsage(m.usage);
      const sources = Array.isArray(m.sources) ? (m.sources as Source[]) : [];
      return {
        role: m.role === "user" ? ("user" as const) : ("assistant" as const),
        content: typeof m.content === "string" ? m.content : "",
        ...(sources.length ? { sources } : {}),
        ...(scope ? { scope } : {}),
        ...(usage ? { usage } : {}),
      };
    });
}

/** Title of a saved chat: the first question, shortened. */
export function chatTitleFrom(messages: Message[]): string {
  const firstUser = messages.find((m) => m.role === "user")?.content || "";
  return firstUser.length > 40 ? `${firstUser.slice(0, 32)}…` : firstUser.slice(0, 40) || "Chat";
}

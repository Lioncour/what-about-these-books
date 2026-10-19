import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { queryAllBooks, searchAllBooksKeyword } from "@/lib/book-store";

export interface EvalCase {
  id: string;
  question: string;
  expectedCitationContains: string[];
  /** Optional keywords that should appear in combined retrieval text */
  expectedInRetrieval?: string[];
}

export interface EvalResult {
  id: string;
  question: string;
  passed: boolean;
  foundCitations: string[];
  missing: string[];
  retrievalHits: number;
}

export interface EvalReport {
  total: number;
  passed: number;
  failed: number;
  score: number;
  results: EvalResult[];
}

export function loadEvalCases(): EvalCase[] {
  const file = join(process.cwd(), "eval", "gold-questions.json");
  if (!existsSync(file)) return [];
  try {
    return JSON.parse(readFileSync(file, "utf-8")) as EvalCase[];
  } catch {
    return [];
  }
}

export async function runEvalHarness(): Promise<EvalReport> {
  const cases = loadEvalCases();
  const results: EvalResult[] = [];

  for (const testCase of cases) {
    const [passages, keywords] = await Promise.all([
      queryAllBooks(testCase.question, 20),
      searchAllBooksKeyword(
        testCase.question
          .split(/\s+/)
          .filter((w) => w.length > 3)
          .slice(0, 4),
        30
      ),
    ]);

    const found = [
      ...passages.map((p) => `${p.bookTitle} ${p.location} ${p.text}`),
      ...keywords.map((k) => `${k.bookTitle} ${k.label} ${k.snippet}`),
    ];
    const haystack = found.join("\n").toLowerCase();

    const missingCitations = testCase.expectedCitationContains.filter(
      (needle) => !found.some((f) => f.toLowerCase().includes(needle.toLowerCase()))
    );
    const missingRetrieval = (testCase.expectedInRetrieval || []).filter(
      (needle) => !haystack.includes(needle.toLowerCase())
    );
    const missing = [...missingCitations, ...missingRetrieval];

    results.push({
      id: testCase.id,
      question: testCase.question,
      passed: missing.length === 0,
      foundCitations: found.slice(0, 30),
      missing,
      retrievalHits: found.length,
    });
  }

  const passed = results.filter((r) => r.passed).length;
  const total = results.length;
  return {
    total,
    passed,
    failed: total - passed,
    score: total ? Number((passed / total).toFixed(3)) : 0,
    results,
  };
}

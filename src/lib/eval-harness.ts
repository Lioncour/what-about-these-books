import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { queryAllBooks } from "@/lib/book-store";

export interface EvalCase {
  id: string;
  question: string;
  expectedCitationContains: string[];
}

export interface EvalResult {
  id: string;
  question: string;
  passed: boolean;
  foundCitations: string[];
  missing: string[];
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
    const passages = await queryAllBooks(testCase.question, 20);
    const found = passages.map((p) => `${p.bookTitle} ${p.location}`);
    const missing = testCase.expectedCitationContains.filter(
      (needle) => !found.some((f) => f.toLowerCase().includes(needle.toLowerCase()))
    );
    results.push({
      id: testCase.id,
      question: testCase.question,
      passed: missing.length === 0,
      foundCitations: found.slice(0, 30),
      missing,
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

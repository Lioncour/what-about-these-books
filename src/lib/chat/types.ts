export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  /** Persisted on assistant turns for memory + reopening sources */
  sources?: ChatSource[];
}

export interface ChatSource {
  book: string;
  excerpt: string;
  position?: string;
  bookId?: string;
}

export interface SpecialistFinding {
  finding: string;
  location: string;
  evidence: string;
}

export type SpecialistConfidence = "high" | "medium" | "low";

export interface SpecialistAnswer {
  bookTitle: string;
  confidence: SpecialistConfidence;
  directAnswer: string;
  numericEstimate: number | null;
  findings: SpecialistFinding[];
  caveats: string[];
}

export interface StreamSpecialistReport {
  bookTitle: string;
  confidence: SpecialistConfidence;
  numericEstimate: number | null;
  directAnswer: string;
  findingsCount: number;
  topFindings: { finding: string; location: string }[];
  caveats: string[];
  reasked?: boolean;
  scorecard?: {
    precisionEstimate: number;
    recallEstimate: number;
    total: number;
  };
}


import type { MemorySearchHit, MemorySearchResult } from '@vibe-context/shared';
import type { MemoryStore, SessionRecord } from './memory-store.js';

export interface MemorySearchQuery {
  projectId: string;
  query: string;
  limit: number;
}

/**
 * Search strategy for past memories.
 *
 * V1: `KeywordMemorySearcher` (in-memory keyword scoring).
 * Later: an FTS5 or embedding based searcher implements the same interface,
 * and the MCP tool does not change.
 */
export interface MemorySearcher {
  readonly strategy: string;
  search(query: MemorySearchQuery): MemorySearchResult;
}

/** How much a match in each field counts. Title and decisions matter most. */
const FIELD_WEIGHTS = {
  title: 3,
  decisions: 2,
  architectureRules: 2,
  summary: 1.5,
  problems: 1.2,
  solutions: 1.2,
  changedFiles: 1,
} as const;

type Field = keyof typeof FIELD_WEIGHTS;
const MAX_FIELD_WEIGHT = Math.max(...Object.values(FIELD_WEIGHTS));
const RECENCY_HALF_LIFE_DAYS = 90;

const STOPWORDS = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'how', 'what', 'about']);
const KOREAN_PARTICLES = /(으로|에서|에게|까지|부터|이랑|하고|을|를|이|가|은|는|에|의|로|와|과|도|만)$/u;
const ENGLISH_SUFFIXES = /(ations?|ions?|ing|ed|es|e|s)$/;

/**
 * Splits a query into normalized search terms.
 * Very light stemming so that "delete" also matches "deletion"/"deleted"
 * and "레시피를" also matches "레시피".
 */
export function tokenize(text: string): string[] {
  const terms = text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 2 && !STOPWORDS.has(word))
    .map((word) => {
      if (/^[a-z]+$/.test(word) && word.length > 4) {
        const stem = word.replace(ENGLISH_SUFFIXES, '');
        return stem.length >= 4 ? stem : word;
      }
      if (/[가-힣]/u.test(word) && word.length >= 3) return word.replace(KOREAN_PARTICLES, '');
      return word;
    });
  return [...new Set(terms)];
}

function fieldTexts(record: SessionRecord): Record<Field, string> {
  return {
    title: record.title.toLowerCase(),
    summary: record.summary.toLowerCase(),
    decisions: record.decisions.join('\n').toLowerCase(),
    architectureRules: record.architectureRules.join('\n').toLowerCase(),
    problems: record.problems.join('\n').toLowerCase(),
    solutions: record.solutions.join('\n').toLowerCase(),
    changedFiles: record.changedFiles.join('\n').toLowerCase(),
  };
}

/**
 * Score (0 to 1):
 *   70% weighted term matches (best field per term)
 * + 30% share of query terms that matched at all
 * then multiplied by a small recency factor (0.9 to 1.0).
 */
function scoreRecord(record: SessionRecord, terms: string[], now: number): { score: number; matchedTerms: string[] } {
  const texts = fieldTexts(record);
  const fields = Object.keys(FIELD_WEIGHTS) as Field[];
  let weighted = 0;
  const matchedTerms: string[] = [];

  for (const term of terms) {
    let best = 0;
    for (const field of fields) {
      if (texts[field].includes(term)) best = Math.max(best, FIELD_WEIGHTS[field]);
    }
    if (best > 0) {
      weighted += best;
      matchedTerms.push(term);
    }
  }
  if (matchedTerms.length === 0) return { score: 0, matchedTerms };

  const relevance = (weighted / (MAX_FIELD_WEIGHT * terms.length)) * 0.7 + (matchedTerms.length / terms.length) * 0.3;
  const ageDays = Math.max(0, (now - record.createdAt.getTime()) / 86_400_000);
  const recency = 0.9 + 0.1 * Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS);
  return { score: Math.round(relevance * recency * 1000) / 1000, matchedTerms };
}

function toHit(record: SessionRecord, score: number, matchedTerms: string[]): MemorySearchHit {
  return {
    sessionId: record.id,
    sessionTitle: record.title,
    summary: record.summary,
    createdAt: record.createdAt.toISOString(),
    score,
    matchedTerms,
    decisions: record.decisions,
    architectureRules: record.architectureRules,
    problems: record.problems,
    solutions: record.solutions,
    changedFiles: record.changedFiles,
  };
}

/**
 * V1 keyword search. Loads the project's sessions and scores them in memory.
 * Good enough for thousands of sessions per project; swap for FTS5 when that stops being true.
 */
export class KeywordMemorySearcher implements MemorySearcher {
  readonly strategy = 'keyword';

  constructor(private readonly store: MemoryStore) {}

  search({ projectId, query, limit }: MemorySearchQuery): MemorySearchResult {
    const terms = tokenize(query);
    const records = this.store.listSessionRecords(projectId);

    // Nothing searchable in the query (e.g. only symbols): return the most recent sessions.
    if (terms.length === 0) {
      return {
        projectId,
        query,
        strategy: this.strategy,
        hits: records.slice(0, limit).map((record) => toHit(record, 0, [])),
      };
    }

    const now = Date.now();
    const hits = records
      .map((record) => ({ record, ...scoreRecord(record, terms, now) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || b.record.createdAt.getTime() - a.record.createdAt.getTime())
      .slice(0, limit)
      .map((item) => toHit(item.record, item.score, item.matchedTerms));

    return { projectId, query, strategy: this.strategy, hits };
  }
}

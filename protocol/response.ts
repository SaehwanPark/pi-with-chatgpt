/**
 * Adviser response contract and parser (INV-01, INV-03, INV-04, INV-07).
 *
 * Implements hybrid structured/prose output parsing:
 *
 * - Opportunistic: extracts headers, sections, and action items when present, but NEVER
 *   fails a consultation due to minor markdown/formatting deviations.
 * - Always preserves the raw response text verbatim.
 * - Anchoring verification: compares the reviewed commit against the expected anchor SHA.
 *   If mismatched or missing, marks provenance ambiguous rather than rewriting the anchor SHA.
 */

import { isConsultationId, type ConsultationId } from "./checkpoint.js";
import { isFullCommitSha, type FullCommitSha } from "./sha.js";

export const JOB_RESULT_STATUSES = ["complete", "degraded", "provenance-ambiguous"] as const;
export type JobResultStatus = (typeof JOB_RESULT_STATUSES)[number];

export const ADVISER_RESPONSE_STATUSES = ["actionable", "inconclusive", "blocked", "unknown"] as const;
export type AdviserResponseStatus = (typeof ADVISER_RESPONSE_STATUSES)[number];

export const PROVENANCE_STATUSES = ["verified", "mismatched", "missing", "malformed"] as const;
export type ProvenanceStatus = (typeof PROVENANCE_STATUSES)[number];

export interface ParsedActionItem {
  readonly id: string;
  readonly summary: string;
}

export interface ParsedAdviserResponse {
  readonly raw: string;
  readonly consultationId?: ConsultationId;
  readonly reviewedCommit?: FullCommitSha;
  readonly status: AdviserResponseStatus;
  readonly assessment?: string;
  readonly recommendation?: string;
  readonly actionItems: readonly ParsedActionItem[];
  readonly risks?: string;
  readonly optionalIdeas?: string;
  readonly provenance: ProvenanceStatus;
  readonly resultStatus: JobResultStatus;
  readonly parsingNotes: readonly string[];
}

export interface ParseResponseOptions {
  readonly expectedCommitSha?: FullCommitSha;
  readonly expectedConsultationId?: ConsultationId;
}

/**
 * Opportunistically parses ChatGPT adviser response text into structured fields.
 */
export function parseAdviserResponse(
  rawText: string,
  options: ParseResponseOptions = {},
): ParsedAdviserResponse {
  const raw = rawText ?? "";
  const trimmed = raw.trim();
  const parsingNotes: string[] = [];

  if (trimmed.length === 0) {
    return {
      raw,
      status: "unknown",
      actionItems: [],
      provenance: "missing",
      resultStatus: "degraded",
      parsingNotes: ["Response was empty"],
    };
  }

  // 1. Extract metadata header block
  const consultationId = extractConsultationId(trimmed);
  if (options.expectedConsultationId && consultationId && consultationId !== options.expectedConsultationId) {
    parsingNotes.push(
      `Response consultation ID "${consultationId}" does not match expected "${options.expectedConsultationId}".`,
    );
  }

  const { reviewedCommit, provenance } = extractAndVerifyCommit(trimmed, options.expectedCommitSha, parsingNotes);

  const status = extractStatus(trimmed, parsingNotes);

  // 2. Extract sections
  const assessment = extractSection(trimmed, "ASSESSMENT");
  const recommendation = extractSection(trimmed, "RECOMMENDATION");
  const risks = extractSection(trimmed, "RISKS");
  const optionalIdeas = extractSection(trimmed, "OPTIONAL IDEAS");

  // 3. Extract action items
  const actionItems = extractActionItems(trimmed, parsingNotes);

  // 4. Determine overall resultStatus
  let resultStatus: JobResultStatus = "complete";
  if (provenance === "mismatched" || provenance === "missing" || provenance === "malformed") {
    resultStatus = "provenance-ambiguous";
  } else if (status === "inconclusive" || status === "blocked") {
    resultStatus = "degraded";
  }

  return {
    raw,
    consultationId,
    reviewedCommit,
    status,
    assessment,
    recommendation,
    actionItems,
    risks,
    optionalIdeas,
    provenance,
    resultStatus,
    parsingNotes,
  };
}

function extractConsultationId(text: string): ConsultationId | undefined {
  const match = /^\s*consultation:\s*([^\s\r\n]+)/im.exec(text);
  if (!match || !match[1]) return undefined;
  const candidate = match[1].trim();
  return isConsultationId(candidate) ? candidate : undefined;
}

function extractAndVerifyCommit(
  text: string,
  expectedSha?: FullCommitSha,
  notes: string[] = [],
): { reviewedCommit?: FullCommitSha; provenance: ProvenanceStatus } {
  const match = /^\s*reviewed_commit:\s*([^\s\r\n]+)/im.exec(text);
  if (!match || !match[1]) {
    notes.push("Missing reviewed_commit in adviser response.");
    return { provenance: "missing" };
  }

  const candidate = match[1].trim().toLowerCase();
  if (!isFullCommitSha(candidate)) {
    notes.push(`Malformed reviewed_commit "${candidate}" (expected 40-character hex SHA).`);
    return { provenance: "malformed" };
  }

  if (expectedSha && candidate !== expectedSha.toLowerCase()) {
    notes.push(
      `Reviewed commit ${candidate.slice(0, 12)} does not match expected anchor commit ${expectedSha.slice(0, 12)}.`,
    );
    return { reviewedCommit: candidate, provenance: "mismatched" };
  }

  return { reviewedCommit: candidate, provenance: "verified" };
}

function extractStatus(text: string, notes: string[]): AdviserResponseStatus {
  const match = /^\s*status:\s*([^\s\r\n]+)/im.exec(text);
  if (!match || !match[1]) {
    notes.push("Missing status field in adviser response; defaulting to unknown.");
    return "unknown";
  }

  const candidate = match[1].trim().toLowerCase();
  if (candidate === "actionable" || candidate === "inconclusive" || candidate === "blocked") {
    return candidate;
  }

  notes.push(`Non-standard status "${candidate}" in response.`);
  return "unknown";
}

/**
 * Extracts a section body by looking for section headings like `## ASSESSMENT`, `ASSESSMENT:`, or `ASSESSMENT`.
 */
function extractSection(text: string, sectionTitle: string): string | undefined {
  // Matches header like `# ASSESSMENT`, `## ASSESSMENT`, `**ASSESSMENT**`, `ASSESSMENT:`, etc.
  const headerPattern = new RegExp(
    `(?:^|\\n)\\s*(?:#{1,4}\\s*|\\*\\*|__)?${sectionTitle}(?:\\*\\*|__)?\\s*:?\\s*\\n+([\\s\\S]*?)(?=(?:\\n\\s*(?:#{1,4}\\s*|\\*\\*|__)?(?:ASSESSMENT|RECOMMENDATION|ACTION ITEMS|RISKS|OPTIONAL IDEAS|ADVISOR)[\\s\\S]*?:?\\s*\\n)|$)`,
    "i",
  );

  const match = headerPattern.exec(text);
  if (!match || !match[1]) return undefined;
  const content = match[1].trim();
  return content.length > 0 ? content : undefined;
}

/**
 * Extracts action items from an ACTION ITEMS section or falls back to whole text search.
 */
function extractActionItems(text: string, notes: string[]): readonly ParsedActionItem[] {
  const sectionContent = extractSection(text, "ACTION ITEMS");
  const targetText = sectionContent ?? text;

  const items: ParsedActionItem[] = [];

  // Pattern 1: A1. Some text / A1: Some text / [A1] Some text / (A1): Some text
  const standardPattern = /(?:^|\n)\s*(?:\[|\()?([A-Z]\d+)(?:\]|\))?[-.:]?\s+([^\n]+(?:\n(?!\s*(?:\[|\()?[A-Z]\d+[-.:)\]]*\s|\s*\d+[.)]\s|\s*[-*]\s)[^\n]+)*)/gu;
  let match: RegExpExecArray | null;

  while ((match = standardPattern.exec(targetText)) !== null) {
    const idCapture = match[1];
    const summaryCapture = match[2];
    if (!idCapture || !summaryCapture) continue;

    const id = idCapture.toUpperCase();
    const summary = summaryCapture.replace(/\s+/g, " ").trim();
    if (summary.length > 0) {
      items.push({ id, summary });
    }
  }

  if (items.length > 0) {
    return items;
  }

  // Fallback pattern if inside ACTION ITEMS section: numbered list 1. ..., 2. ...
  if (sectionContent) {
    const numberedPattern = /(?:^|\n)\s*(\d+)[.)]\s*([^\n]+(?:\n(?!\s*\d+[.)]|\s*[-*]\s)[^\n]+)*)/gu;
    let ordinal = 1;
    while ((match = numberedPattern.exec(sectionContent)) !== null) {
      const summaryCapture = match[2];
      if (!summaryCapture) continue;

      const summary = summaryCapture.replace(/\s+/g, " ").trim();
      if (summary.length > 0) {
        items.push({ id: `A${ordinal}`, summary });
        ordinal++;
      }
    }

    if (items.length > 0) {
      notes.push("Action items lacked A1/A2 prefixes; normalized sequentially.");
      return items;
    }
  }

  return [];
}

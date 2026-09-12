/**
 * `ui/tui.ts` — Compact TUI status formatting and user-facing presentation (INV-13).
 *
 * Excludes all browser internals, DOM selectors, session profile paths, and OAuth tokens.
 */

import type { ConsultationKind } from "../protocol/brief.js";
import type { DriftVerdict, AdviceCurrency } from "../drift/index.js";
import type { LedgerRecord } from "../ledger/record.js";
import type { LedgerEntry } from "../ledger/ledger.js";

export interface DispatchStatusInfo {
  readonly consultationId: string;
  readonly kind: ConsultationKind;
  readonly remoteRepo: string;
  readonly commitSha: string;
  readonly mode: "sync" | "async";
  readonly prNumber?: number;
}

export interface CompletionNotificationInfo {
  readonly consultationId: string;
  readonly kind: ConsultationKind;
  readonly drift?: { readonly verdict: DriftVerdict; readonly currency: AdviceCurrency };
  readonly actionItems?: ReadonlyArray<{ readonly ordinal: number; readonly summary: string; readonly disposition?: string }>;
  readonly degradedReason?: string;
}

export function formatDispatchStatus(info: DispatchStatusInfo): string {
  const shortSha = info.commitSha.slice(0, 7);
  const prPart = info.prNumber ? ` pr=#${info.prNumber}` : "";
  return `[advisor:${info.kind}] dispatching ${info.consultationId} (${info.remoteRepo}@${shortSha}${prPart}, ${info.mode})`;
}

export function formatCompletionNotification(info: CompletionNotificationInfo): string {
  const parts: string[] = [];
  if (info.degradedReason) {
    parts.push(`[advisor:${info.kind}] Consultation ${info.consultationId} completed with degradation: ${info.degradedReason}`);
  } else {
    const driftText = info.drift ? ` [drift: ${info.drift.currency}]` : "";
    parts.push(`[advisor:${info.kind}] Consultation ${info.consultationId} complete.${driftText}`);
  }

  if (info.actionItems && info.actionItems.length > 0) {
    parts.push("Top action items:");
    for (const item of info.actionItems.slice(0, 3)) {
      const disp = item.disposition ? ` (${item.disposition})` : "";
      parts.push(`  - [A${item.ordinal}] ${item.summary}${disp}`);
    }
  }

  parts.push(`Run /advisor-read ${info.consultationId} to view full advice.`);
  return parts.join("\n");
}

export function formatFullAdvisoryView(record: LedgerRecord | LedgerEntry, adviceText?: string): string {
  const lines: string[] = [];
  const state = "schemaVersion" in record ? record.status : record.state;
  const createdAt = "createdAt" in record ? record.createdAt : record.dispatchedAt ?? "unknown";

  lines.push(`# Consultation Advisory: ${record.consultationId}`);
  lines.push(`- **Kind**: \`${record.kind}\``);
  lines.push(`- **Target Checkpoint**: \`${record.resolvedCommit}\` (${record.requestedRef})`);
  lines.push(`- **State**: \`${state}\``);
  lines.push(`- **Dependency**: \`${record.dependency}\``);
  lines.push(`- **Created**: ${createdAt}`);

  if (record.actionItems.length > 0) {
    lines.push("");
    lines.push("## Action Items");
    for (const [index, item] of record.actionItems.entries()) {
      const idStr = "id" in item ? item.id : `A${item.ordinal ?? index + 1}`;
      const note = "dispositionNote" in item && item.dispositionNote ? ` — Reason: ${item.dispositionNote}` : "";
      lines.push(`- **[${idStr}]** \`${item.disposition}\`: ${item.summary}${note}`);
    }
  }

  const content = adviceText ?? ("adviserAnswer" in record ? record.adviserAnswer : undefined);
  if (content) {
    lines.push("");
    lines.push("## Adviser Response");
    lines.push(content);
  }

  return lines.join("\n");
}

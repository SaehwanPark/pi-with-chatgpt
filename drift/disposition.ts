/**
 * Action item disposition tracking (INV-01, INV-12, INV-15).
 *
 * Records worker and human decisions on adviser recommendations:
 * accepted, implemented, partially_implemented, rejected_with_reason,
 * superseded, stale, needs_reconsultation.
 */

import type { ConsultationId } from "../protocol/checkpoint.js";
import type { GitHubRepositoryKey } from "../protocol/repo.js";
import {
  type ConsultationLedger,
  type ActionItemDisposition,
  type LedgerEntry,
  isActionItemDisposition,
} from "../ledger/ledger.js";
import { assertCredentialFreeValue } from "../ledger/record.js";

export class DispositionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DispositionValidationError";
  }
}

export interface RecordDispositionOptions {
  readonly consultationId: ConsultationId;
  readonly repository: GitHubRepositoryKey;
  readonly actionItemId: string;
  readonly disposition: ActionItemDisposition;
  readonly reason?: string;
}

/**
 * Records a disposition on an action item inside a completed consultation record.
 */
export async function recordActionItemDisposition(
  ledger: ConsultationLedger,
  options: RecordDispositionOptions,
): Promise<LedgerEntry> {
  const { consultationId, repository, actionItemId, disposition, reason } = options;

  if (!isActionItemDisposition(disposition)) {
    throw new DispositionValidationError(`Invalid action item disposition: "${disposition as string}"`);
  }

  // Rejection and supersession require an explanatory reason (Section 6)
  if (disposition === "rejected_with_reason" || disposition === "superseded") {
    if (!reason || reason.trim().length === 0) {
      throw new DispositionValidationError(
        `A reason is required when marking an action item as "${disposition}".`,
      );
    }
  }

  if (reason) {
    assertCredentialFreeValue("disposition note", reason);
  }

  return await ledger.updateActionItemDisposition({
    consultationId,
    repository,
    actionItemId,
    disposition,
    dispositionNote: reason?.trim(),
  });
}

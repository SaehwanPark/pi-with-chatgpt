import { describe, expect, it } from "vitest";

import { parseAdviserResponse } from "./response.js";
import type { FullCommitSha } from "./sha.js";
import type { ConsultationId } from "./checkpoint.js";

const VALID_ID = "adv-0014" as ConsultationId;
const ANCHOR_SHA = "8f731e2890123456789012345678901234567890" as FullCommitSha;
const OTHER_SHA = "da5c991890123456789012345678901234567890" as FullCommitSha;

describe("parseAdviserResponse", () => {
  it("parses a valid structured response matching anchor SHA", () => {
    const raw = `
ADVISOR
consultation: adv-0014
reviewed_commit: 8f731e2890123456789012345678901234567890
status: actionable

ASSESSMENT
The proposed architecture provides clean separation of duties.

RECOMMENDATION
Proceed with the staged roll-out.

ACTION ITEMS
A1. Add mutex serialization for session turn dispatch.
A2. Write unit tests for race conditions.

RISKS
High memory usage if concurrency limit is too high.

OPTIONAL IDEAS
Consider LRU cache for conversation tokens.
`.trim();

    const parsed = parseAdviserResponse(raw, {
      expectedCommitSha: ANCHOR_SHA,
      expectedConsultationId: VALID_ID,
    });

    expect(parsed.raw).toBe(raw);
    expect(parsed.consultationId).toBe(VALID_ID);
    expect(parsed.reviewedCommit).toBe(ANCHOR_SHA);
    expect(parsed.status).toBe("actionable");
    expect(parsed.assessment).toBe("The proposed architecture provides clean separation of duties.");
    expect(parsed.recommendation).toBe("Proceed with the staged roll-out.");
    expect(parsed.actionItems).toEqual([
      { id: "A1", summary: "Add mutex serialization for session turn dispatch." },
      { id: "A2", summary: "Write unit tests for race conditions." },
    ]);
    expect(parsed.risks).toBe("High memory usage if concurrency limit is too high.");
    expect(parsed.optionalIdeas).toBe("Consider LRU cache for conversation tokens.");
    expect(parsed.provenance).toBe("verified");
    expect(parsed.resultStatus).toBe("complete");
    expect(parsed.parsingNotes).toEqual([]);
  });

  it("handles markdown header syntax (## ASSESSMENT, etc.)", () => {
    const raw = `
ADVISOR
consultation: adv-0014
reviewed_commit: 8f731e2890123456789012345678901234567890
status: actionable

## ASSESSMENT
Everything looks solid.

## RECOMMENDATION
Merge the changes.

## ACTION ITEMS
[A1] Verify backward compatibility.
(A2): Check documentation.
`.trim();

    const parsed = parseAdviserResponse(raw, { expectedCommitSha: ANCHOR_SHA });

    expect(parsed.assessment).toBe("Everything looks solid.");
    expect(parsed.recommendation).toBe("Merge the changes.");
    expect(parsed.actionItems).toHaveLength(2);
    expect(parsed.actionItems[0]?.id).toBe("A1");
    expect(parsed.actionItems[0]?.summary).toBe("Verify backward compatibility.");
    expect(parsed.actionItems[1]?.id).toBe("A2");
    expect(parsed.actionItems[1]?.summary).toBe("Check documentation.");
  });

  it("detects mismatched reviewed commit SHA and marks provenance-ambiguous without failing", () => {
    const raw = `
ADVISOR
consultation: adv-0014
reviewed_commit: ${OTHER_SHA}
status: actionable

ASSESSMENT
I looked at a newer commit.
`.trim();

    const parsed = parseAdviserResponse(raw, { expectedCommitSha: ANCHOR_SHA });

    expect(parsed.reviewedCommit).toBe(OTHER_SHA);
    expect(parsed.provenance).toBe("mismatched");
    expect(parsed.resultStatus).toBe("provenance-ambiguous");
    expect(parsed.parsingNotes.some((n) => n.includes("does not match expected anchor commit"))).toBe(true);
    expect(parsed.raw).toBe(raw);
  });

  it("detects missing reviewed commit SHA", () => {
    const raw = `
ADVISOR
consultation: adv-0014
status: actionable

ASSESSMENT
General advice without mentioning SHA.
`.trim();

    const parsed = parseAdviserResponse(raw, { expectedCommitSha: ANCHOR_SHA });

    expect(parsed.reviewedCommit).toBeUndefined();
    expect(parsed.provenance).toBe("missing");
    expect(parsed.resultStatus).toBe("provenance-ambiguous");
  });

  it("detects malformed reviewed commit SHA", () => {
    const raw = `
ADVISOR
consultation: adv-0014
reviewed_commit: 8f731e2 (short sha)
status: actionable
`.trim();

    const parsed = parseAdviserResponse(raw, { expectedCommitSha: ANCHOR_SHA });

    expect(parsed.provenance).toBe("malformed");
    expect(parsed.resultStatus).toBe("provenance-ambiguous");
  });

  it("normalizes numbered action items when A1/A2 prefix is absent", () => {
    const raw = `
ADVISOR
consultation: adv-0014
reviewed_commit: ${ANCHOR_SHA}
status: actionable

ACTION ITEMS
1. First task to complete.
2. Second task to complete.
`.trim();

    const parsed = parseAdviserResponse(raw, { expectedCommitSha: ANCHOR_SHA });

    expect(parsed.actionItems).toEqual([
      { id: "A1", summary: "First task to complete." },
      { id: "A2", summary: "Second task to complete." },
    ]);
    expect(parsed.parsingNotes).toContain("Action items lacked A1/A2 prefixes; normalized sequentially.");
  });

  it("opportunistically parses partial / unstructured responses without throwing", () => {
    const raw = "I think you should reconsider your design entirely. It might fail under load.";

    const parsed = parseAdviserResponse(raw, { expectedCommitSha: ANCHOR_SHA });

    expect(parsed.raw).toBe(raw);
    expect(parsed.status).toBe("unknown");
    expect(parsed.provenance).toBe("missing");
    expect(parsed.resultStatus).toBe("provenance-ambiguous");
    expect(parsed.actionItems).toEqual([]);
  });

  it("handles empty or whitespace response gracefully", () => {
    const parsed = parseAdviserResponse("   ", { expectedCommitSha: ANCHOR_SHA });

    expect(parsed.raw).toBe("   ");
    expect(parsed.status).toBe("unknown");
    expect(parsed.resultStatus).toBe("degraded");
    expect(parsed.parsingNotes).toContain("Response was empty");
  });

  it("flags inconclusive or blocked status as degraded when provenance is verified", () => {
    const raw = `
ADVISOR
consultation: adv-0014
reviewed_commit: ${ANCHOR_SHA}
status: inconclusive

ASSESSMENT
Cannot determine correctness due to missing test fixtures.
`.trim();

    const parsed = parseAdviserResponse(raw, { expectedCommitSha: ANCHOR_SHA });

    expect(parsed.status).toBe("inconclusive");
    expect(parsed.provenance).toBe("verified");
    expect(parsed.resultStatus).toBe("degraded");
  });
});

/**
 * Machine-readable index of the architecture invariants (INV-01 … INV-16).
 *
 * The prose authority is `docs/ARCHITECTURE.md` plus the proposal; this module exists so tests
 * and tooling can refer to an invariant by ID instead of by prose, and so a missing guard for a
 * known invariant is visible as a gap in `INVARIANT_GUARDS` rather than as a forgotten comment.
 *
 * Adding an invariant here without a documented prose source and a guard (or an explicit
 * `planned:<milestone>` marker) is how the invariant set silently rots — do not do it.
 */

export type InvariantId =
  | "INV-01"
  | "INV-02"
  | "INV-03"
  | "INV-04"
  | "INV-05"
  | "INV-06"
  | "INV-07"
  | "INV-08"
  | "INV-09"
  | "INV-10"
  | "INV-11"
  | "INV-12"
  | "INV-13"
  | "INV-14"
  | "INV-15"
  | "INV-16";

export const INVARIANT_IDS: readonly InvariantId[] = [
  "INV-01",
  "INV-02",
  "INV-03",
  "INV-04",
  "INV-05",
  "INV-06",
  "INV-07",
  "INV-08",
  "INV-09",
  "INV-10",
  "INV-11",
  "INV-12",
  "INV-13",
  "INV-14",
  "INV-15",
  "INV-16",
] as const;

export interface InvariantDefinition {
  readonly id: InvariantId;
  readonly summary: string;
  /** Where the authoritative prose lives. */
  readonly source: string;
  /**
   * Where the guard lives. `planned:M<n>` means the invariant is real but the enforcing code
   * lands in that milestone; the marker is asserted by `invariants.test.ts` so a planned guard
   * cannot silently stay planned after its milestone ships.
   */
  readonly guard: string;
}

export const INVARIANTS: readonly InvariantDefinition[] = [
  {
    id: "INV-01",
    summary: "ChatGPT has no execution ownership: adviser text never reaches shell, edit, git, or scheduler calls.",
    source: "docs/ARCHITECTURE.md#inv-01",
    guard: "protocol/trust.ts",
  },
  {
    id: "INV-02",
    summary: "Source-code context reaches the adviser through GitHub only in V1 (no archives, uploads, tunnels, bridges).",
    source: "docs/ARCHITECTURE.md#inv-02",
    guard: "protocol/context-channel.ts",
  },
  {
    id: "INV-03",
    summary: "Every consultation is anchored to an immutable full commit SHA; requestedRef is stored separately and never retargeted.",
    source: "docs/ARCHITECTURE.md#inv-03",
    guard: "protocol/sha.ts + protocol/checkpoint.ts",
  },
  {
    id: "INV-04",
    summary: "Remote reachability on the selected GitHub remote is verified before dispatch; otherwise a structured result is returned.",
    source: "docs/ARCHITECTURE.md#inv-04",
    guard: "git/remote-availability.ts + git/checkpoint-resolution.ts",
  },
  {
    id: "INV-05",
    summary: "Adviser output is untrusted, non-authoritative input, subordinate to code, tests, and user instructions.",
    source: "docs/ARCHITECTURE.md#inv-05",
    guard: "protocol/trust.ts",
  },
  {
    id: "INV-06",
    summary: "A consultation implies no git authority: no blanket staging, no auto-commit, no auto-push.",
    source: "docs/ARCHITECTURE.md#inv-06",
    guard: "git/authority.ts",
  },
  {
    id: "INV-07",
    summary: "Adviser failure is non-blocking by default (dependency: advisory); blocking is explicit.",
    source: "docs/ARCHITECTURE.md#inv-07",
    guard: "protocol/dependency.ts",
  },
  {
    id: "INV-08",
    summary: "One ChatGPT Project maps to one GitHub repository, keyed by stable repository identity.",
    source: "docs/ARCHITECTURE.md#inv-08",
    guard: "chatgpt/scope.ts",
  },
  {
    id: "INV-09",
    summary: "Unrelated tasks use separate adviser conversations; delivery is keyed by consultation identity.",
    source: "docs/ARCHITECTURE.md#inv-09",
    guard: "chatgpt/scope.ts + jobs/state.ts",
  },
  {
    id: "INV-10",
    summary: "The adviser never silently switches OpenAI/ChatGPT accounts; a mismatch is an explicit user decision.",
    source: "docs/ARCHITECTURE.md#inv-10",
    guard: "auth/identity.ts + auth/adviser-auth.ts",
  },
  {
    id: "INV-11",
    summary: "The adviser browser runtime is isolated and extension-owned; the user's active browser is never automated.",
    source: "docs/ARCHITECTURE.md#inv-11",
    // The login port has no interaction method at all, so automation is impossible by construction
    // rather than by convention.
    guard: "browser/profile.ts + auth/login-flow.ts + browser/cookie-import.ts",
  },
  {
    id: "INV-12",
    summary: "Credentials, cookies, and tokens never enter logs, ledger records, config, or model context.",
    source: "docs/ARCHITECTURE.md#inv-12",
    // `protocol/masking.ts` is the guard the modules share: the rule lives once, so a module that
    // displays an account cannot re-derive it loosely.
    guard:
      "config/schema.ts + ledger/record.ts + auth/secret-text.ts + auth/status.ts + protocol/masking.ts + browser/chrome-state.ts",
  },
  {
    id: "INV-13",
    summary: "The worker receives structured advice only; browser/protocol internals stay out of prompt text.",
    source: "docs/ARCHITECTURE.md#inv-13",
    guard: "ui/worker-facing.ts + auth/status.ts",
  },
  {
    id: "INV-14",
    summary: "Trust order: code at the requested commit > consultation brief > conversation > Project instructions > memory.",
    source: "docs/ARCHITECTURE.md#inv-14",
    guard: "planned:M6",
  },
  {
    id: "INV-15",
    summary: "Provenance persists outside model context; the ledger is local and is never auto-published to a repo, issue, or PR.",
    source: "docs/ARCHITECTURE.md#inv-15",
    guard: "ledger/record.ts",
  },
  {
    id: "INV-16",
    summary: "V1 scope guard: no non-GitHub hosts, no additional adviser providers, no publish-to-PR by default.",
    source: "docs/ARCHITECTURE.md#inv-16",
    guard: "protocol/context-channel.ts + protocol/provider.ts",
  },
] as const;

/** Guard locations that are intentionally deferred to a later milestone. */
export function plannedGuards(): readonly InvariantDefinition[] {
  return INVARIANTS.filter((invariant) => invariant.guard.startsWith("planned:"));
}

export function invariantById(id: InvariantId): InvariantDefinition | undefined {
  return INVARIANTS.find((invariant) => invariant.id === id);
}

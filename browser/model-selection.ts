/**
 * M3 — choosing which adviser model to ask, given what the account can actually select right now.
 *
 * `selectAdviserModel` in `capability-checks.ts` answers the earlier question ("is the requested model on
 * the list?"). This module answers the runtime question: a consultation names a *preference list* (the
 * user's ranked favourites), the live picker reports which models exist and whether each is selectable,
 * and we must pick one without ever silently settling for weaker advice.
 *
 * The rule that shapes everything: **a downgrade is reported, never hidden**. Returning a fallback model is
 * sometimes right (the user asked for the best available), but returning it *as if it were the requested
 * model* is the failure the user cannot see — they get thinner advice and no signal. So every path that did
 * not land on the top preference says so via `degraded` and `reason`.
 */
import type { ModelOption } from "./runtime-types.js";

/** The default asks for the strongest selectable model reported by the live picker. */
export const DEFAULT_MODEL_PREFERENCE = ["auto-best"] as const;

export type ModelSelection =
  | { readonly ok: true; readonly model: ModelOption; readonly degraded: boolean; readonly reason?: string }
  | { readonly ok: false; readonly reason: "no-models" | "none-available" | "preference-empty"; readonly tried: readonly string[] };

/**
 * Pick the first preference that is both present and currently selectable.
 *
 * `preference` is ordered best-first. Entries that do not appear in `available` are skipped (the account
 * simply does not have them); entries present but marked unavailable are *skipped too* — an option the
 * picker greyed out cannot be clicked, and reporting "model-unavailable" is better than a click that no-ops.
 */
export function resolveModelPreference(
  preference: readonly string[],
  available: readonly ModelOption[],
): ModelSelection {
  const tried = available.map((option) => option.modelId);
  if (available.length === 0) return { ok: false, reason: "no-models", tried };
  if (preference.length === 0) return { ok: false, reason: "preference-empty", tried };

  const selectable = available.filter((option) => option.available);
  if (selectable.length === 0) return { ok: false, reason: "none-available", tried };

  // Match on the id *or* the display label, because a saved preference may record either form and the
  // picker may report either. Normalising both sides is what keeps a rename from losing every preference.
  for (const wanted of preference) {
    // `auto-best` is a policy, not a model id. It must never be passed through to the browser as a
    // synthetic selection, and it must not inherit the picker's DOM ordering by taking `selectable[0]`.
    if (normalise(wanted) === "autobest") {
      const best = strongestSelectable(selectable);
      const unranked = modelCapabilityRank(best) === 0;
      return {
        ok: true,
        model: best,
        degraded: wanted !== preference[0] || unranked,
        ...(wanted !== preference[0]
          ? { reason: `top preference "${String(preference[0])}" unavailable` }
          : unranked
            ? { reason: "model capability ranking unavailable; selected deterministically" }
            : {}),
      };
    }
    const match = selectable.find((option) => sameModel(option, wanted));
    if (match) {
      return {
        ok: true,
        model: match,
        // Degraded iff the top preference was not the one we landed on.
        degraded: wanted !== preference[0],
        ...(wanted === preference[0] ? {} : { reason: `top preference "${String(preference[0])}" unavailable` }),
      };
    }
  }

  // Nothing on the preference list is selectable. Fall back to the strongest selectable model and flag it
  // — the account's picker order is presentation detail, not a capability ranking.
  const fallback = strongestSelectable(selectable);
  const fallbackReason = modelCapabilityRank(fallback) === 0
    ? "no preference available; model capability ranking unavailable"
    : "no preference available; used most capable selectable model";
  return { ok: true, model: fallback, degraded: true, reason: fallbackReason };
}

/**
 * Rank the model labels we can observe without relying on provider internals.
 *
 * The numeric family/version is the primary signal. A small, explicit variant adjustment handles common
 * labels such as "mini" and "pro"; unknown labels are still selected deterministically by their id rather
 * than by DOM order. This is intentionally a bounded heuristic: a new provider naming scheme should be
 * surfaced as a stable choice until its ranking policy is reviewed, not guessed from arbitrary page order.
 */
function strongestSelectable(options: readonly ModelOption[]): ModelOption {
  return options.reduce((best, candidate) => (compareModelCapability(candidate, best) > 0 ? candidate : best));
}

function compareModelCapability(left: ModelOption, right: ModelOption): number {
  const rankDifference = modelCapabilityRank(left) - modelCapabilityRank(right);
  if (rankDifference !== 0) return rankDifference;
  // A stable tie-break makes auto-best independent of the DOM's insertion order while keeping equivalent
  // labels reproducible across calls.
  const leftId = normalise(left.modelId);
  const rightId = normalise(right.modelId);
  return rightId.localeCompare(leftId);
}

function modelCapabilityRank(option: ModelOption): number {
  const label = `${option.modelId} ${option.displayName}`.toLowerCase();
  const gpt = /\bgpt[\s_-]?(\d+)(?:\.(\d+))?/u.exec(label);
  const reasoning = /\bo[\s_-]?(\d+)(?:\.(\d+))?/u.exec(label);
  const match = gpt ?? reasoning;
  if (!match) return 0;

  const family = gpt ? 2_000_000 : 1_000_000;
  const major = Number.parseInt(match[1] ?? "0", 10);
  const minor = Number.parseInt(match[2] ?? "0", 10);
  let variant = 0;
  if (/\b(?:pro|max|thinking|reasoning)\b/u.test(label)) variant += 20;
  if (/\b(?:mini|nano|small|fast|instant|lite)\b/u.test(label)) variant -= 20;
  return family + major * 1_000 + minor * 100 + variant;
}

function sameModel(option: ModelOption, wanted: string): boolean {
  const needle = normalise(wanted);
  return normalise(option.modelId) === needle || normalise(option.displayName) === needle;
}

function normalise(value: string): string {
  return value.toLowerCase().replace(/[\s_-]+/gu, "");
}

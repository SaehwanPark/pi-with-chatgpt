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

  // Nothing on the preference list is selectable. Fall back to the first selectable model and flag it —
  // the user still gets the strongest model the account allows, clearly labelled as a fallback.
  const fallback = selectable[0] as ModelOption;
  return { ok: true, model: fallback, degraded: true, reason: "no preference available; used most capable selectable model" };
}

function sameModel(option: ModelOption, wanted: string): boolean {
  const needle = normalise(wanted);
  return normalise(option.modelId) === needle || normalise(option.displayName) === needle;
}

function normalise(value: string): string {
  return value.toLowerCase().replace(/[\s_-]+/gu, "");
}

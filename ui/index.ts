/**
 * `ui/` — TUI status surfaces and the compact, worker-facing advice message.
 *
 * M0 fixes what the worker is allowed to see (`worker-facing.ts`). The TUI status component and the
 * `/advisor*` commands land in M8 and must keep using this allowlist rather than serialising state.
 */

export * from "./worker-facing.js";
export * from "./tui.js";
export * from "./policy.js";

/**
 * `ledger/` — durable consultation state that outlives model context.
 *
 * M4 adds private atomic state files and locks for Project/conversation mappings; the consultation
 * ledger and job integration remain later-milestone work.
 */

export * from "./record.js";
export * from "./state-store.js";

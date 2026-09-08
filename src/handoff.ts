export const HANDOFF_INSTRUCTION = "Address the review feedback below using the file paths, captured snippets, and Original/Modified comparison context. Paths are relative to the opened project folder; locations and snippets may be stale. All explicitly approved changes are already staged. Never stage or unstage anything; only the reviewer manages staging. Summarize your changes in this conversation.";

/** Bound to the selected repository's saved REVIEW-NOTES.md and its editor buffer. */
export interface HandoffPort {
  /** Return undefined only when the file is absent; reject other read failures. */
  read(): Promise<string | undefined>;
  isDirty(): boolean;
  copy(text: string): Promise<void>;
  /** Resolve only once the exact raw snapshot is durably archived. */
  archive(snapshot: string): Promise<void>;
  remove(snapshot: string): Promise<void>;
}

export type HandoffResult =
  | { status: "empty" }
  | { status: "dirty" }
  | { status: "changed" }
  | { status: "copied" }
  | { status: "copyFailed"; error: unknown }
  | { status: "archiveFailed"; error: unknown }
  | { status: "deleteFailed"; error: unknown }
  | { status: "readFailed"; error: unknown };

/**
 * The caller owns per-repository mutation serialization and save/discard UI.
 * `copied` includes a file removed externally after clipboard success, but
 * always requires the initial snapshot to have been archived successfully.
 * `dirty` and `readFailed` can occur before or after copying; never restore the
 * clipboard on failure. `archiveFailed`, `changed`, and `deleteFailed` imply
 * clipboard success; the latter two also imply archive success.
 */
export async function copyAndClear(port: HandoffPort): Promise<HandoffResult> {
  if (port.isDirty()) return { status: "dirty" };

  let snapshot: string | undefined;
  try {
    snapshot = await port.read();
  } catch (error) {
    return { status: "readFailed", error };
  }

  if (port.isDirty()) return { status: "dirty" };
  if (snapshot === undefined || snapshot.trim() === "") {
    return { status: "empty" };
  }

  try {
    await port.copy(`${HANDOFF_INSTRUCTION}\n\n${snapshot}`);
  } catch (error) {
    return { status: "copyFailed", error };
  }

  try {
    await port.archive(snapshot);
  } catch (error) {
    return { status: "archiveFailed", error };
  }

  if (port.isDirty()) return { status: "dirty" };

  let current: string | undefined;
  try {
    current = await port.read();
  } catch (error) {
    return { status: "readFailed", error };
  }

  if (port.isDirty()) return { status: "dirty" };
  if (current === undefined) return { status: "copied" };
  if (current !== snapshot) return { status: "changed" };

  // Unavoidable filesystem TOCTOU: an external writer can change the file
  // between this check and removal; this port has no atomic compare-and-delete.
  try {
    await port.remove(snapshot);
  } catch (error) {
    return { status: "deleteFailed", error };
  }
  return { status: "copied" };
}

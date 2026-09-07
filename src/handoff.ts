export const HANDOFF_INSTRUCTION = "Review feedback follows. Address the comments using the included file paths and captured code snippets as context; line numbers and snippets may be stale. Side: left refers to Original, Side: right to Modified, and Side: document to a regular editor. Each comparison records both resources; lines and snippets belong to the selected side, not necessarily the current working-tree file. Staging remains under the human's control. This feedback was copied from a completed review pass; do not read, recreate, or reply in COMMENTS.md. Summarize your changes in this conversation.";

/** Bound to the selected repository's saved COMMENTS.md and its editor buffer. */
export interface HandoffPort {
  /** Return undefined only when the file is absent; reject other read failures. */
  read(): Promise<string | undefined>;
  isDirty(): boolean;
  copy(text: string): Promise<void>;
  remove(): Promise<void>;
}

export type HandoffResult =
  | { status: "empty" }
  | { status: "dirty" }
  | { status: "changed" }
  | { status: "copied" }
  | { status: "copyFailed"; error: unknown }
  | { status: "deleteFailed"; error: unknown }
  | { status: "readFailed"; error: unknown };

/**
 * The caller owns per-repository mutation serialization and save/discard UI.
 * `copied` includes a file removed externally after clipboard success.
 * `dirty` and `readFailed` can occur before or after copying; never restore the
 * clipboard on failure. `changed` and `deleteFailed` imply clipboard success.
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
    await port.remove();
  } catch (error) {
    return { status: "deleteFailed", error };
  }
  return { status: "copied" };
}

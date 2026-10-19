export const HANDOFF_INSTRUCTION = "Please address these review notes and summarize your changes here. Leave staging to me.";

export type HandoffResult =
  | { status: "empty" }
  | { status: "dirty" }
  | { status: "changed" }
  | { status: "copied" }
  | { status: "copyFailed"; error: unknown }
  | { status: "archiveFailed"; error: unknown }
  | { status: "deleteFailed"; error: unknown }
  | { status: "readFailed"; error: unknown };

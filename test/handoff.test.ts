import * as assert from "node:assert/strict";
import { test } from "node:test";
import { HANDOFF_INSTRUCTION } from "../src/handoff";

test("exports the exact self-contained handoff instruction", () => {
  assert.equal(HANDOFF_INSTRUCTION, "Please address these review notes and summarize your changes here. Leave staging to me.");
});

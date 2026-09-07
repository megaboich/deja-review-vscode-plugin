import * as assert from "node:assert/strict";
import { test } from "node:test";
import {
  copyAndClear,
  HANDOFF_INSTRUCTION,
  type HandoffPort,
} from "../src/handoff";

function fixture(initial: string | undefined = "Review notes") {
  const state: {
    saved: string | undefined;
    dirty: boolean;
    clipboard: string;
    events: string[];
  } = {
    saved: initial,
    dirty: false,
    clipboard: "previous clipboard",
    events: [],
  };
  const port: HandoffPort = {
    async read() {
      state.events.push("read");
      return state.saved;
    },
    isDirty() {
      state.events.push("dirty");
      return state.dirty;
    },
    async copy(text) {
      state.events.push("copy");
      state.clipboard = text;
    },
    async remove() {
      state.events.push("remove");
      state.saved = undefined;
    },
  };
  return { state, port };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("exports the exact self-contained specification instruction", () => {
  assert.equal(HANDOFF_INSTRUCTION, "Review feedback follows. Address the comments using the included file paths and captured code snippets as context; line numbers and snippets may be stale. Side: left refers to Original, Side: right to Modified, and Side: document to a regular editor. Each comparison records both resources; lines and snippets belong to the selected side, not necessarily the current working-tree file. Staging remains under the human's control. This feedback was copied from a completed review pass; do not read, recreate, or reply in COMMENTS.md. Summarize your changes in this conversation.");
});

test("awaits clipboard success before rereading and deleting the exact snapshot", async () => {
  const snapshot = "\uFEFF# Review\r\n\r\n"
    + "## File: `old.ts`; Lines: 2-3; Origin: head; Side: left\r\n"
    + "```ts\r\n  oldCode();  \r\n```\r\n"
    + "Comparison: Left: `old.ts` (head); Right: `new.ts` (changed)\r\n"
    + "Stale snippet: fix this anyway.\r\n\r\n"
    + "## File: `new.ts`; Lines: 8; Origin: changed; Side: right\r\n"
    + "```ts\r\n  newCode();\r\n```\r\n"
    + "Comparison: Left: `old.ts` (head); Right: `new.ts` (changed)\r\n"
    + "Preserve this too.\r\n\t";
  const { state, port } = fixture(snapshot);
  const started = deferred();
  const finish = deferred();
  port.copy = async (text) => {
    state.events.push("copy:start");
    started.resolve();
    await finish.promise;
    state.clipboard = text;
    state.events.push("copy:done");
  };

  const result = copyAndClear(port);
  await started.promise;
  assert.deepEqual(state.events, ["dirty", "read", "dirty", "copy:start"]);
  assert.equal(state.saved, snapshot);
  assert.equal(state.clipboard, "previous clipboard");
  finish.resolve();

  assert.deepEqual(await result, { status: "copied" });
  assert.equal(state.clipboard, `${HANDOFF_INSTRUCTION}\n\n${snapshot}`);
  assert.equal(state.saved, undefined);
  assert.deepEqual(state.events, [
    "dirty", "read", "dirty", "copy:start", "copy:done",
    "dirty", "read", "dirty", "remove",
  ]);
});

for (const snapshot of [
  "## File: broken; Lines: nope\n```unclosed\n  raw text  ",
  "\n  Free-form notes only.\r\n\tKeep all whitespace.\n\n",
  "## Unknown section\nHand-written notes\n",
]) {
  test(`copies opaque feedback verbatim: ${JSON.stringify(snapshot)}`, async () => {
    const { state, port } = fixture(snapshot);
    assert.deepEqual(await copyAndClear(port), { status: "copied" });
    assert.equal(state.clipboard, `${HANDOFF_INSTRUCTION}\n\n${snapshot}`);
    assert.equal(state.saved, undefined);
  });
}

for (const snapshot of [undefined, "", " \t\r\n\n", "\uFEFF\u00A0"]) {
  test(`leaves absent or whitespace-only feedback untouched: ${JSON.stringify(snapshot)}`, async () => {
    const { state, port } = fixture();
    state.saved = snapshot;
    assert.deepEqual(await copyAndClear(port), { status: "empty" });
    assert.equal(state.saved, snapshot);
    assert.equal(state.clipboard, "previous clipboard");
    assert.deepEqual(state.events, ["dirty", "read", "dirty"]);
  });
}

test("initial dirty buffer prevents reads, copying, and deletion", async () => {
  const { state, port } = fixture();
  state.dirty = true;
  assert.deepEqual(await copyAndClear(port), { status: "dirty" });
  assert.equal(state.saved, "Review notes");
  assert.equal(state.clipboard, "previous clipboard");
  assert.deepEqual(state.events, ["dirty"]);
});

test("a buffer becoming dirty during the initial read prevents copying", async () => {
  const { state, port } = fixture();
  const read = port.read;
  port.read = async () => {
    const snapshot = await read();
    state.dirty = true;
    return snapshot;
  };
  assert.deepEqual(await copyAndClear(port), { status: "dirty" });
  assert.equal(state.saved, "Review notes");
  assert.equal(state.clipboard, "previous clipboard");
  assert.deepEqual(state.events, ["dirty", "read", "dirty"]);
});

test("a buffer becoming dirty during copying prevents even the second read", async () => {
  const { state, port } = fixture();
  const copy = port.copy;
  port.copy = async (text) => {
    await copy(text);
    state.dirty = true;
  };
  assert.deepEqual(await copyAndClear(port), { status: "dirty" });
  assert.equal(state.saved, "Review notes");
  assert.equal(state.clipboard, `${HANDOFF_INSTRUCTION}\n\nReview notes`);
  assert.deepEqual(state.events, ["dirty", "read", "dirty", "copy", "dirty"]);
});

for (const saved of ["Review notes", undefined]) {
  test(`dirty buffer after reread prevents clearing even if file is ${saved === undefined ? "absent" : "unchanged"}`, async () => {
    const { state, port } = fixture();
    const read = port.read;
    let reads = 0;
    port.read = async () => {
      const snapshot = await read();
      if (++reads === 2) {
        state.saved = saved;
        state.dirty = true;
        return saved;
      }
      return snapshot;
    };
    assert.deepEqual(await copyAndClear(port), { status: "dirty" });
    assert.equal(state.saved, saved);
    assert.equal(state.clipboard, `${HANDOFF_INSTRUCTION}\n\nReview notes`);
    assert.deepEqual(state.events, ["dirty", "read", "dirty", "copy", "dirty", "read", "dirty"]);
  });
}

for (const newer of ["New saved feedback", "Review notes\n", "", " \n"]) {
  test(`retains concurrently saved changes: ${JSON.stringify(newer)}`, async () => {
    const { state, port } = fixture();
    const copy = port.copy;
    port.copy = async (text) => {
      await copy(text);
      state.saved = newer;
    };
    assert.deepEqual(await copyAndClear(port), { status: "changed" });
    assert.equal(state.saved, newer);
    assert.equal(state.clipboard, `${HANDOFF_INSTRUCTION}\n\nReview notes`);
    assert.equal(state.events.includes("remove"), false);
  });
}

test("external deletion after copying returns copied without removing again", async () => {
  const { state, port } = fixture();
  const copy = port.copy;
  port.copy = async (text) => {
    await copy(text);
    state.saved = undefined;
  };
  assert.deepEqual(await copyAndClear(port), { status: "copied" });
  assert.equal(state.clipboard, `${HANDOFF_INSTRUCTION}\n\nReview notes`);
  assert.equal(state.events.includes("remove"), false);
});

test("clipboard rejection retains the file without rereading or deleting", async () => {
  const { state, port } = fixture();
  const error = new Error("clipboard unavailable");
  port.copy = async () => {
    state.events.push("copy");
    throw error;
  };
  assert.deepEqual(await copyAndClear(port), { status: "copyFailed", error });
  assert.equal(state.saved, "Review notes");
  assert.equal(state.clipboard, "previous clipboard");
  assert.deepEqual(state.events, ["dirty", "read", "dirty", "copy"]);
});

for (const failureOnRead of [1, 2]) {
  test(`read failure on read ${failureOnRead} never deletes or restores the clipboard`, async () => {
    const { state, port } = fixture();
    const error = { reason: "read unavailable" };
    let reads = 0;
    port.read = async () => {
      state.events.push("read");
      if (++reads === failureOnRead) throw error;
      return state.saved;
    };
    const result = await copyAndClear(port);
    assert.deepEqual(result, { status: "readFailed", error });
    if (result.status === "readFailed") assert.equal(result.error, error);
    assert.equal(state.saved, "Review notes");
    assert.equal(state.clipboard, failureOnRead === 1
      ? "previous clipboard" : `${HANDOFF_INSTRUCTION}\n\nReview notes`);
    assert.equal(state.events.includes("remove"), false);
  });
}

test("deletion failure reports partial success and leaves the copied snapshot intact", async () => {
  const { state, port } = fixture();
  const error = "permission denied";
  port.remove = async () => {
    state.events.push("remove");
    throw error;
  };
  assert.deepEqual(await copyAndClear(port), { status: "deleteFailed", error });
  assert.equal(state.saved, "Review notes");
  assert.equal(state.clipboard, `${HANDOFF_INSTRUCTION}\n\nReview notes`);
  assert.deepEqual(state.events, ["dirty", "read", "dirty", "copy", "dirty", "read", "dirty", "remove"]);
});

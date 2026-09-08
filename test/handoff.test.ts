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
    archives: string[];
    events: string[];
  } = {
    saved: initial,
    dirty: false,
    clipboard: "previous clipboard",
    archives: [],
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
    async archive(snapshot) {
      state.events.push("archive");
      state.archives.push(snapshot);
    },
    async remove(snapshot) {
      state.events.push("remove");
      assert.equal(snapshot, state.saved);
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

test("exports the exact self-contained handoff instruction", () => {
  assert.equal(HANDOFF_INSTRUCTION, "Address the review feedback below using the file paths, captured snippets, and Original/Modified comparison context. Paths are relative to the opened project folder; locations and snippets may be stale. All explicitly approved changes are already staged. Never stage or unstage anything; only the reviewer manages staging. Summarize your changes in this conversation.");
});

test("awaits clipboard and durable archive success before rereading and deleting the exact snapshot", async () => {
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
  const archiveStarted = deferred();
  const archiveFinish = deferred();
  port.copy = async (text) => {
    state.events.push("copy:start");
    started.resolve();
    await finish.promise;
    state.clipboard = text;
    state.events.push("copy:done");
  };
  port.archive = async (text) => {
    state.events.push("archive:start");
    archiveStarted.resolve();
    await archiveFinish.promise;
    state.archives.push(text);
    state.events.push("archive:done");
  };

  const result = copyAndClear(port);
  await started.promise;
  assert.deepEqual(state.events, ["dirty", "read", "dirty", "copy:start"]);
  assert.equal(state.saved, snapshot);
  assert.equal(state.clipboard, "previous clipboard");
  assert.deepEqual(state.archives, []);
  finish.resolve();
  await archiveStarted.promise;
  assert.deepEqual(state.events, ["dirty", "read", "dirty", "copy:start", "copy:done", "archive:start"]);
  assert.equal(state.clipboard, `${HANDOFF_INSTRUCTION}\n\n${snapshot}`);
  assert.equal(state.saved, snapshot);
  assert.deepEqual(state.archives, []);
  archiveFinish.resolve();

  assert.deepEqual(await result, { status: "copied" });
  assert.equal(state.clipboard, `${HANDOFF_INSTRUCTION}\n\n${snapshot}`);
  assert.equal(state.saved, undefined);
  assert.deepEqual(state.archives, [snapshot]);
  assert.deepEqual(state.events, [
    "dirty", "read", "dirty", "copy:start", "copy:done",
    "archive:start", "archive:done",
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
    assert.deepEqual(state.archives, [snapshot]);
  });
}

for (const snapshot of [undefined, "", " \t\r\n\n", "\uFEFF\u00A0"]) {
  test(`leaves absent or whitespace-only feedback untouched: ${JSON.stringify(snapshot)}`, async () => {
    const { state, port } = fixture();
    state.saved = snapshot;
    assert.deepEqual(await copyAndClear(port), { status: "empty" });
    assert.equal(state.saved, snapshot);
    assert.equal(state.clipboard, "previous clipboard");
    assert.deepEqual(state.archives, []);
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

test("a buffer becoming dirty during copying still archives but prevents even the second read", async () => {
  const { state, port } = fixture();
  const copy = port.copy;
  port.copy = async (text) => {
    await copy(text);
    state.dirty = true;
  };
  assert.deepEqual(await copyAndClear(port), { status: "dirty" });
  assert.equal(state.saved, "Review notes");
  assert.equal(state.clipboard, `${HANDOFF_INSTRUCTION}\n\nReview notes`);
  assert.deepEqual(state.archives, ["Review notes"]);
  assert.deepEqual(state.events, ["dirty", "read", "dirty", "copy", "archive", "dirty"]);
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
    assert.deepEqual(state.archives, ["Review notes"]);
    assert.deepEqual(state.events, ["dirty", "read", "dirty", "copy", "archive", "dirty", "read", "dirty"]);
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
    assert.deepEqual(state.archives, ["Review notes"]);
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
  assert.deepEqual(state.archives, ["Review notes"]);
  assert.deepEqual(state.events, ["dirty", "read", "dirty", "copy", "archive", "dirty", "read", "dirty"]);
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
  assert.deepEqual(state.archives, []);
});

test("archive rejection retains the file and copied clipboard without rereading or deleting", async () => {
  const { state, port } = fixture();
  const error = new Error("archive unavailable");
  port.archive = async (snapshot) => {
    state.events.push("archive");
    assert.equal(snapshot, "Review notes");
    throw error;
  };
  assert.deepEqual(await copyAndClear(port), { status: "archiveFailed", error });
  assert.equal(state.saved, "Review notes");
  assert.equal(state.clipboard, `${HANDOFF_INSTRUCTION}\n\nReview notes`);
  assert.deepEqual(state.archives, []);
  assert.deepEqual(state.events, ["dirty", "read", "dirty", "copy", "archive"]);
});

test("external deletion cannot report copied when archiving fails", async () => {
  const { state, port } = fixture();
  const error = new Error("archive rename failed");
  port.archive = async () => {
    state.saved = undefined;
    throw error;
  };
  assert.deepEqual(await copyAndClear(port), { status: "archiveFailed", error });
  assert.equal(state.clipboard, `${HANDOFF_INSTRUCTION}\n\nReview notes`);
  assert.deepEqual(state.archives, []);
  assert.equal(state.events.includes("remove"), false);
});

for (const newer of ["New feedback", "", " \n", undefined]) {
  test(`changes during archiving preserve live content: ${JSON.stringify(newer)}`, async () => {
    const { state, port } = fixture();
    const started = deferred();
    const finish = deferred();
    const archive = port.archive;
    port.archive = async (snapshot) => {
      started.resolve();
      await finish.promise;
      await archive(snapshot);
    };
    const result = copyAndClear(port);
    await started.promise;
    state.saved = newer;
    finish.resolve();
    assert.deepEqual(await result, { status: newer === undefined ? "copied" : "changed" });
    assert.equal(state.saved, newer);
    assert.equal(state.clipboard, `${HANDOFF_INSTRUCTION}\n\nReview notes`);
    assert.deepEqual(state.archives, ["Review notes"]);
    assert.equal(state.events.includes("remove"), false);
  });
}

test("a buffer becoming dirty during archiving retains the file and recoverable snapshot", async () => {
  const { state, port } = fixture();
  const started = deferred();
  const finish = deferred();
  const archive = port.archive;
  port.archive = async (snapshot) => {
    started.resolve();
    await finish.promise;
    await archive(snapshot);
  };
  const result = copyAndClear(port);
  await started.promise;
  state.dirty = true;
  finish.resolve();
  assert.deepEqual(await result, { status: "dirty" });
  assert.equal(state.saved, "Review notes");
  assert.equal(state.clipboard, `${HANDOFF_INSTRUCTION}\n\nReview notes`);
  assert.deepEqual(state.archives, ["Review notes"]);
  assert.deepEqual(state.events, ["dirty", "read", "dirty", "copy", "archive", "dirty"]);
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
    assert.deepEqual(state.archives, failureOnRead === 1 ? [] : ["Review notes"]);
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
  assert.deepEqual(state.archives, ["Review notes"]);
  assert.deepEqual(state.events, ["dirty", "read", "dirty", "copy", "archive", "dirty", "read", "dirty", "remove"]);
});

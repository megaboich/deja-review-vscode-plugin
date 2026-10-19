import * as assert from "node:assert/strict";
import { inspect } from "node:util";
import { Window } from "happy-dom";
import type { DashboardState } from "../src/dashboard";
import { renderDashboard } from "../src/dashboardHtml";

/**
 * Deterministic stand-in for the Web Animations API.
 *
 * happy-dom implements `animate()` with real timers. Exit-animation tests need to settle
 * or cancel an animation at an exact point to exercise reappearance races, so the real
 * implementation is replaced rather than awaited.
 */
class ControlledAnimation implements Pick<Animation, 'cancel'> {
  readonly finished: Promise<void>;
  private resolveFinished?: () => void;
  private rejectFinished?: (error: Error) => void;
  cancelled = false;

  constructor(readonly frames: Keyframe[], readonly options: KeyframeAnimationOptions) {
    this.finished = new Promise((resolve, reject) => {
      this.resolveFinished = resolve;
      this.rejectFinished = reject;
    });
  }

  finish(): void {
    // The client consumes only settlement, not the resolved animation.
    this.resolveFinished?.();
  }

  cancel(): void {
    this.cancelled = true;
    this.rejectFinished?.(new Error('Animation cancelled'));
  }
}

/** Test affordances patched onto happy-dom elements; not part of the client's DOM contract. */
export type Element = Omit<HTMLElement, 'children'> & {
  /** Snapshot array rather than a live HTMLCollection, so tests can use array methods. */
  readonly children: Element[];
  readonly parent: Element | undefined;
  readonly content?: Element;
  /** Layout-free stand-in for the collapse animation's measured start height. */
  height: number;
  animations: ControlledAnimation[];
  disabled: boolean;
  value: string;
  type: string;
  dateTime: string;
  open: boolean;
  selectionStart: number;
  selectionEnd: number;
  readonly showModalCalls: number;
  readonly closeCalls: number;
  /** Dispatches a real event and reports whether a listener called preventDefault. */
  dispatch(name: string, key?: string): boolean;
  /** Fires click without the browser's disabled-button suppression, to reach client guards. */
  invokeListener(name: string): void;
};

type ClientMessage = {
  type: string;
  repoKey?: string;
  archiveId?: string;
  noteId?: string;
  fileId?: string;
  editorId?: string;
  body?: string;
  requestId?: string;
};

export function lastMessage(messages: readonly ClientMessage[]): ClientMessage {
  const message = messages.at(-1);
  assert.ok(message, 'Expected a captured client message');
  return message;
}

// Keep raw client output rather than decoding with the production validator:
// exact-message assertions must still catch missing or unexpected keys.
function isClientMessage(message: unknown): message is ClientMessage {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return false;
  }
  if (!("type" in message) || typeof message.type !== "string") {
    return false;
  }
  for (const key of ["repoKey", "archiveId", "noteId", "fileId", "editorId", "body", "requestId"]) {
    if (key in message && typeof Reflect.get(message, key) !== "string") {
      return false;
    }
  }
  return true;
}

type DocumentFacade = {
  /** Assigning focuses the element; reading reports happy-dom's real focus owner. */
  activeElement: Element | null;
  readonly root: Element;
};

type ClientFixture = {
  elements: Map<string, Element>;
  element(id: string): Element;
  messages: ClientMessage[];
  document: DocumentFacade;
  receive(message: unknown): void;
  showArchives(): void;
  update(next: DashboardState): void;
  setReducedMotion(reduced: boolean): void;
};

let clientSequence = 0;

/** Installs the test affordances declared on `Element` onto this window's prototype. */
function patchElementPrototype(window: Window): void {
  // Patch the shared Element prototype, not HTMLElement: the icons the client clones are SVG
  // elements, which inherit from SVGElement and would otherwise miss these affordances.
  const proto = window.Element.prototype as unknown as Element & Record<string, unknown>;
  // happy-dom shares prototypes between Window instances; wrapping twice would
  // double-count dialog calls and re-wrap the original methods.
  if (proto.__dejareviewPatched) {
    return;
  }
  proto.__dejareviewPatched = true;

  Object.defineProperty(proto, 'height', {
    configurable: true,
    get(this: Record<string, unknown>) { return (this.__height as number | undefined) ?? 64; },
    set(this: Record<string, unknown>, value: number) { this.__height = value; },
  });
  Object.defineProperty(proto, 'animations', {
    configurable: true,
    get(this: Record<string, unknown>) {
      this.__animations ??= [];
      return this.__animations;
    },
  });
  // The client only indexes and spreads children; an array also gives tests find/filter.
  const liveChildren = Object.getOwnPropertyDescriptor(window.Element.prototype, 'children');
  assert.ok(liveChildren?.get, 'Expected happy-dom to expose a children getter');
  Object.defineProperty(proto, 'children', {
    configurable: true,
    get(this: Element) { return Array.from(liveChildren.get!.call(this) as ArrayLike<Element>); },
  });
  Object.defineProperty(proto, 'parent', {
    configurable: true,
    get(this: Element) { return this.parentElement ?? undefined; },
  });

  const dialog = window.HTMLDialogElement.prototype as unknown as Record<string, unknown>;
  const showModal = dialog.showModal as (this: unknown) => void;
  const close = dialog.close as (this: unknown) => void;
  for (const [name, original] of [['showModal', showModal], ['close', close]] as const) {
    const counter = `__${name}Calls`;
    Object.defineProperty(dialog, `${name}Calls`, {
      configurable: true,
      get(this: Record<string, unknown>) { return (this[counter] as number | undefined) ?? 0; },
    });
    dialog[name] = function (this: Record<string, unknown>) {
      this[counter] = ((this[counter] as number | undefined) ?? 0) + 1;
      original.call(this);
    };
  }

  proto.getBoundingClientRect = function (this: Element) {
    // happy-dom has no layout engine; the client only reads height for its keyframes.
    return { height: this.height } as DOMRect;
  };
  proto.animate = function (this: Element, frames: Keyframe[], options: KeyframeAnimationOptions) {
    const animation = new ControlledAnimation(frames, options);
    this.animations.push(animation);
    return animation as unknown as Animation;
  };

  proto.dispatch = function (this: Element, name: string, key?: string): boolean {
    const event = key === undefined
      ? new window.Event(name, { bubbles: true, cancelable: true })
      : new window.KeyboardEvent(name, { key, bubbles: true, cancelable: true });
    // dispatchEvent reports "not cancelled"; tests assert on preventDefault having run.
    const prevented = !this.dispatchEvent(event as unknown as Event);
    // The client leaves button activation to the browser, which happy-dom does not
    // synthesize. Reproduce it so keyboard-activation tests exercise the real path.
    const activatesButton = (name === 'keydown' && key === 'Enter') || (name === 'keyup' && key === ' ');
    if (!prevented && activatesButton && this.tagName === 'BUTTON'
      && this.ownerDocument.activeElement === (this as unknown as globalThis.Element)) {
      this.click();
    }
    return prevented;
  };
  proto.invokeListener = function (this: Element, name: string): void {
    assert.equal(name, 'click', 'Only click bypasses native disabled handling');
    this.dispatchEvent(new window.MouseEvent('click', { bubbles: true }) as unknown as Event);
  };
  // `click()` is defined on HTMLElement, so SVG icons lack it. Tests click icons to prove the
  // event reaches the enclosing button; HTMLElement's own implementation still takes priority.
  proto.click ??= function (this: Element): void {
    this.dispatchEvent(new window.MouseEvent('click', { bubbles: true }) as unknown as Event);
  };

  // An element inspects into its whole window/document graph: one failed assertion involving
  // an element costs ~74s and a ~2MB message. Report a short identity instead.
  Object.defineProperty(proto, inspect.custom, {
    configurable: true,
    value(this: Element) {
      const id = this.id ? `#${this.id}` : '';
      const classes = this.className ? `.${this.className.trim().split(/\s+/).join('.')}` : '';
      return `<${this.tagName.toLowerCase()}${id}${classes}>`;
    },
  });
}

export function scriptFixture(cache: { value?: unknown } = {}, instanceKey = "test-instance"): ClientFixture {
  const fixtureSequence = ++clientSequence;
  const html = renderDashboard("test-nonce", instanceKey);
  const window = new Window();
  patchElementPrototype(window);

  const script = html.match(/<script nonce="test-nonce">([\s\S]*?)<\/script>/);
  assert.ok(script, "Expected a nonce-protected dashboard client script");
  // Parse the real shell so element structure comes from the shipped HTML, not a stub tree.
  window.document.write(html.replace(script[0], ""));

  const messages: ClientMessage[] = [];
  let requestSequence = 0;
  let motionChange: (() => void) | undefined;
  const motion = {
    matches: true,
    addEventListener(name: string, listener: () => void): void {
      assert.equal(name, 'change');
      motionChange = listener;
    },
  };

  Object.assign(window, {
    acquireVsCodeApi: () => ({
      postMessage(message: unknown) {
        assert.ok(isClientMessage(message), "Expected string fields in client transport output");
        messages.push(message as ClientMessage);
      },
      getState: () => cache.value,
      setState: (value: unknown) => { cache.value = value; },
    }),
    matchMedia(query: string) {
      assert.equal(query, '(prefers-reduced-motion: reduce)');
      return motion;
    },
    getComputedStyle: () => ({
      paddingTop: '10px', paddingBottom: '10px', marginTop: '0px', marginBottom: '0px',
      borderTopWidth: '0px', borderBottomWidth: '1px',
    }),
    crypto: { randomUUID: () => instanceKey + ":" + ++requestSequence + ":" + fixtureSequence },
  });

  window.eval(script[1]);
  assert.equal(messages[0]?.type, "ready", "Expected the client to announce readiness");

  function element(id: string): Element {
    const node = window.document.getElementById(id);
    assert.ok(node, `Expected dashboard element #${id}`);
    return node as unknown as Element;
  }

  const elements = new Map<string, Element>();
  for (const node of window.document.querySelectorAll('[id]')) {
    elements.set(node.id, node as unknown as Element);
  }

  const post = (message: unknown): void => {
    const event = new window.MessageEvent('message', { data: message });
    (window.dispatchEvent as (value: unknown) => void)(event);
  };

  return {
    elements,
    element,
    messages,
    document: {
      get activeElement() { return window.document.activeElement as unknown as Element | null; },
      set activeElement(node: Element | null) { node?.focus(); },
      get root() { return window.document.body as unknown as Element; },
    },
    receive: post,
    showArchives() {
      element("more").click();
      element("show-archives").click();
    },
    update: (next: DashboardState) => post({ type: "state", state: next }),
    setReducedMotion(reduced: boolean) {
      motion.matches = reduced;
      motionChange?.();
    },
  };
}

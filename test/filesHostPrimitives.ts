import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import type * as vscode from 'vscode';

type UriParts = Pick<vscode.Uri, 'scheme' | 'authority' | 'path' | 'query' | 'fragment'>;

// Preserve the synthetic host's URI identity format; this is not a URI parser.
export class Uri implements vscode.Uri {
  scheme = 'file';
  authority = '';
  path = '';
  query = '';
  fragment = '';

  get fsPath(): string { return this.path; }

  static file(value: string): Uri {
    return Uri.from({ path: value });
  }

  static from(value: Partial<UriParts>): Uri {
    return Object.assign(new Uri(), value);
  }

  static joinPath(base: Uri, ...parts: string[]): Uri {
    return Uri.from({ ...base, path: path.posix.join(base.path, ...parts) });
  }

  with(change: Partial<UriParts>): Uri {
    return Uri.from({ ...this, ...change });
  }

  toString(): string {
    return `${this.scheme}://${this.authority}${this.path}?${this.query}#${this.fragment}`;
  }

  toJSON(): UriParts {
    return { scheme: this.scheme, authority: this.authority, path: this.path, query: this.query, fragment: this.fragment };
  }
}

export class EventEmitter<T = void> implements vscode.Disposable {
  private listeners = new Set<(value: T) => void>();
  readonly event: vscode.Event<T> = listener => {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  };

  fire(value: T): void {
    for (const listener of this.listeners) {
      listener(value);
    }
  }

  dispose(): void {
    this.listeners.clear();
  }
}

export class Range {
  readonly start: Pick<vscode.Position, 'line' | 'character'>;
  readonly end: Pick<vscode.Position, 'line' | 'character'>;

  constructor(startLine: number, startCharacter: number, endLine: number, endCharacter: number) {
    this.start = { line: startLine, character: startCharacter };
    this.end = { line: endLine, character: endCharacter };
  }
}

export class MarkdownString implements vscode.MarkdownString {
  constructor(public value = '') {}

  appendText(value: string): this {
    this.value += value;
    return this;
  }

  appendMarkdown(value: string): this {
    this.value += value;
    return this;
  }

  appendCodeblock(value: string, language = ''): this {
    this.value += `\n\`\`\`${language}\n${value}\n\`\`\`\n`;
    return this;
  }
}

export function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>(done => { resolve = done; });
  assert.ok(resolve, 'Promise executor must initialize the fixture gate synchronously');
  return { promise, resolve };
}

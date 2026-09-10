import * as path from 'node:path';
import * as vscode from 'vscode';
import type { GitResources, Repository } from './git';
import { normalizeComment, type Comparison, type Resource, type ReviewComment, type Side } from './model';

export interface CapturedContext {
  repo: Repository;
  comment: ReviewComment;
  uri: vscode.Uri;
  baseCommit?: string;
  validate(): Promise<void>;
}

interface ContextChoice extends vscode.QuickPickItem {
  side: Side;
  input?: vscode.TabInputTextDiff;
}

type CaptureOptions = {
  forceSidePrompt?: boolean;
  inferFromOpenTabs?: boolean;
  tabInput?: vscode.TabInputText | vscode.TabInputTextDiff;
  rangeSemantics?: 'selection' | 'thread';
};

type FrozenTab = { readonly input: unknown; readonly label: string; readonly active: boolean };
type FrozenEditor = {
  readonly key: string;
  readonly start: number;
  readonly end: number;
  readonly input: unknown;
  readonly forcePrompt: boolean;
  readonly tabs: readonly FrozenTab[];
  readonly displayed: ReadonlyMap<string, string>;
};
type CapturedEndpoint = { resource: Resource; text?: string };

// Text documents can normalize line endings when Git's blob is loaded. Compare
// logical lines without changing the frozen text used for the captured snippet.
function sameRevisionText(displayed: string, revision: string): boolean {
  return displayed.replace(/\r\n|\r/g, '\n') === revision.replace(/\r\n|\r/g, '\n');
}

function hasMutableOrigin(resource: Resource): boolean {
  return resource.origin === 'head' || resource.origin === 'staged';
}

// The async resource resolver checks ownership; this final synchronous check
// closes the tilde-mapping interval after other endpoints have awaited.
function sameBaselineMapping(endpoint: vscode.Uri, resource: Resource, repo: Repository): boolean {
  if (endpoint.scheme !== 'git' || !hasMutableOrigin(resource)) { return true; }
  const query: unknown = JSON.parse(endpoint.query);
  if (!query || typeof query !== 'object' || !('ref' in query) || query.ref !== '~') { return true; }
  if (!('path' in query) || typeof query.path !== 'string') { return false; }
  const fileKey = vscode.Uri.file(query.path).toString();
  const indexed = repo.state.indexChanges?.some(change => change.uri.toString() === fileKey);
  return resource.origin === (indexed ? 'staged' : 'head');
}

function describe(uri: vscode.Uri): string {
  if (uri.scheme === 'file') { return `${uri.fsPath} (changed)`; }
  if (uri.scheme === 'git') {
    try {
      const query: unknown = JSON.parse(uri.query);
      if (query && typeof query === 'object' && 'path' in query && 'ref' in query
        && typeof query.path === 'string' && typeof query.ref === 'string') {
        let origin: string;
        switch (query.ref) {
          case '~':
            origin = 'baseline';
            break;
          case '':
            origin = 'staged';
            break;
          case 'HEAD':
          case 'head':
            origin = 'head';
            break;
          default:
            origin = `ref: ${query.ref}`;
        }
        return `${query.path} (${origin})`;
      }
    } catch { /* Malformed queries are explained by GitResources when selected. */ }
  }
  return uri.toString();
}

function freezeEditor(uri: vscode.Uri, range: vscode.Range, options: CaptureOptions): FrozenEditor {
  // Freeze all editor-derived state before Git initialization or any picker changes focus.
  // Native threads reach capture only at submission; draft-creation text cannot be recovered here.
  const key = uri.toString();
  const start = range.start.line;
  const end = options.rangeSemantics !== 'thread' && !range.isEmpty && range.end.character === 0
    ? range.end.line - 1 : range.end.line;
  let input = options.tabInput ?? vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  let forcePrompt = options.forceSidePrompt === true;
  const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs.map(tab => ({
    input: tab.input, label: tab.label, active: tab.isActive && group.isActive,
  })));
  if (options.inferFromOpenTabs) {
    // Native replies expose a URI/range, not the gutter's originating tab. Infer
    // only a unique open context; editor focus after typing is not provenance.
    const contexts = new Map<string, vscode.TabInputText | vscode.TabInputTextDiff>();
    for (const tab of tabs) {
      const candidate = tab.input;
      if (candidate instanceof vscode.TabInputText && candidate.uri.toString() === key) {
        contexts.set('document', candidate);
      } else if (candidate instanceof vscode.TabInputTextDiff
        && (candidate.original.toString() === key || candidate.modified.toString() === key)) {
        contexts.set(JSON.stringify([candidate.original.toString(), candidate.modified.toString()]), candidate);
      }
    }
    input = contexts.size === 1 ? [...contexts.values()][0] : undefined;
    forcePrompt = options.forceSidePrompt === true || contexts.size !== 1;
  }
  const endpointKeys = new Set([key]);
  for (const candidate of [input, ...tabs.map(tab => tab.input)]) {
    if (candidate instanceof vscode.TabInputTextDiff
      && (candidate.original.toString() === key || candidate.modified.toString() === key)) {
      endpointKeys.add(candidate.original.toString());
      endpointKeys.add(candidate.modified.toString());
    }
  }
  const displayed = new Map(vscode.workspace.textDocuments.filter(doc => !doc.isClosed && endpointKeys.has(doc.uri.toString()))
    .map(doc => [doc.uri.toString(), doc.getText()]));
  return { key, start, end, input, forcePrompt, tabs, displayed };
}

function staleCapture(): Error {
  return new Error('The Git revision or review base changed since capture. Reopen the comparison and select the source lines again.');
}

async function resolveEndpoint(
  git: GitResources, repo: Repository, endpoint: vscode.Uri, frozenEditor: FrozenEditor,
  checkRevision: (endpoint: vscode.Uri, resource: Resource) => void,
): Promise<CapturedEndpoint> {
  if (await git.repositoryFor(endpoint) !== repo) {
    throw new Error('Both comparison endpoints must be files in the same Git repository and opened folder.');
  }
  const resource = await git.resource(endpoint, repo);
  if (!resource) { throw new Error('This comparison contains an unsupported resource.'); }

  const endpointKey = endpoint.toString();
  const frozen = frozenEditor.displayed.get(endpointKey);
  // Undisplayed opposite panes need identity only. A displayed empty Git
  // pane must still match an empty blob or a confirmed missing path.
  if (endpointKey !== frozenEditor.key && frozen === undefined) {
    checkRevision(endpoint, resource);
    return { resource };
  }
  const revision = endpoint.scheme === 'git' || frozen === undefined
    ? await git.content(resource, repo, endpointKey !== frozenEditor.key && frozen === '') : frozen;
  if (endpoint.scheme === 'git' && frozen !== undefined && !sameRevisionText(frozen, revision)) {
    throw staleCapture();
  }
  checkRevision(endpoint, resource);
  return { resource, text: frozen ?? revision };
}

async function chooseContext(
  frozen: FrozenEditor, resource: Resource,
  resolveComparison: (diff: vscode.TabInputTextDiff) => Promise<void>,
): Promise<ContextChoice | undefined> {
  const { key, input, forcePrompt, tabs } = frozen;
  if (!forcePrompt && input instanceof vscode.TabInputTextDiff) {
    const left = input.original.toString() === key;
    const right = input.modified.toString() === key;
    if (left !== right) {
      await resolveComparison(input);
      return { label: '', side: left ? 'left' : 'right', input };
    }
  } else if (!forcePrompt && input instanceof vscode.TabInputText && input.uri.toString() === key) {
    return { label: '', side: 'document' };
  }

  const choices: ContextChoice[] = [{
    label: `Document: ${path.basename(resource.path)}`,
    description: `${resource.path} (${resource.origin})`,
    detail: 'Regular document, without comparison context',
    side: 'document',
  }];
  const relevant = [...tabs];
  if (input instanceof vscode.TabInputTextDiff && !relevant.some(tab => tab.input === input)) {
    relevant.unshift({ input, label: 'Captured comparison', active: false });
  }
  const seen = new Set<string>();
  for (const tab of relevant) {
    if (!(tab.input instanceof vscode.TabInputTextDiff)) { continue; }
    const diff = tab.input;
    if (diff.original.toString() !== key && diff.modified.toString() !== key) { continue; }
    const pairKey = JSON.stringify([diff.original.toString(), diff.modified.toString()]);
    if (seen.has(pairKey)) { continue; }
    seen.add(pairKey);
    try {
      await resolveComparison(diff);
    } catch {
      // An unrelated tab must not prevent choosing Document or another valid comparison.
      continue;
    }
    for (const side of ['left', 'right'] as const) {
      const endpoint = side === 'left' ? diff.original : diff.modified;
      // Never transfer the captured range/text to the opposite or an unrelated URI.
      if (endpoint.toString() !== key) { continue; }
      choices.push({
        label: `${side === 'left' ? 'Left / Original' : 'Right / Modified'}: ${path.basename(resource.path)}`,
        description: `${tab.label}${tab.active ? ' (active tab)' : ''} - ${resource.origin}`,
        detail: `Left: ${describe(diff.original)} -> Right: ${describe(diff.modified)}`,
        side,
        input: diff,
      });
    }
  }
  return vscode.window.showQuickPick(choices, {
    title: 'Where did you add this review note?',
    placeHolder: 'Choose the editor or comparison you used; the original context cannot be determined uniquely.',
    ignoreFocusOut: true,
    matchOnDescription: true,
    matchOnDetail: true,
  });
}

export async function captureContext(
  git: GitResources,
  uri: vscode.Uri,
  range: vscode.Range,
  options: CaptureOptions = {},
): Promise<CapturedContext | undefined> {
  const frozen = freezeEditor(uri, range, options);
  const { key, start, end, input, forcePrompt } = frozen;

  let captureListener: vscode.Disposable | undefined;
  try {
    if (uri.scheme !== 'file' && uri.scheme !== 'git') {
      throw new Error('Review notes support only file and Git text documents inside a repository.');
    }
    if (input !== undefined && !(input instanceof vscode.TabInputText) && !(input instanceof vscode.TabInputTextDiff)
      && !forcePrompt) {
      throw new Error('This editor is not a supported text editor or text comparison. Merge, notebook, and custom editors are not supported.');
    }
    const repo = await git.repositoryFor(uri);
    if (!repo) { throw new Error('This document is not inside an open Git repository. Open its repository and retry.'); }
    const baseCommit = repo.state.HEAD?.commit;
    let captureChanged = false;
    captureListener = repo.state.onDidChange(() => { captureChanged = true; });
    const checkRevision = (endpoint: vscode.Uri, resource: Resource): void => {
      if (!hasMutableOrigin(resource)) { return; }
      if (captureChanged || repo.state.HEAD?.commit !== baseCommit
        || !sameBaselineMapping(endpoint, resource, repo)) {
        throw staleCapture();
      }
    };
    const endpoints = new Map<string, Promise<CapturedEndpoint>>();
    const resolve = (endpoint: vscode.Uri): Promise<CapturedEndpoint> => {
      const endpointKey = endpoint.toString();
      let pending = endpoints.get(endpointKey);
      if (!pending) {
        pending = resolveEndpoint(git, repo, endpoint, frozen, checkRevision);
        endpoints.set(endpointKey, pending);
      }
      return pending;
    };
    const { resource, text: capturedText } = await resolve(uri);
    if (capturedText === undefined) { throw new Error('The selected source text is unavailable. Reopen the document and retry.'); }
    const comparisons = new Map<vscode.TabInputTextDiff, Comparison>();
    const resolveComparison = async (diff: vscode.TabInputTextDiff): Promise<void> => {
      if (comparisons.has(diff)) { return; }
      const [left, right] = await Promise.all([resolve(diff.original), resolve(diff.modified)]);
      comparisons.set(diff, { left: left.resource, right: right.resource });
    };
    const lines = capturedText.split(/\r\n|\n|\r/);
    if (start < 0 || end < start || end >= lines.length) {
      throw new Error('The captured line range is no longer available in this document. Select the source lines again.');
    }
    let eol = '\r';
    if (capturedText.includes('\r\n')) {
      eol = '\r\n';
    } else if (capturedText.includes('\n')) {
      eol = '\n';
    }
    const selected = lines.slice(start, end + 1);
    const anchorText = (selected.length > 20 ? [...selected.slice(0, 10), '...', ...selected.slice(-5)] : selected).join(eol);
    const choice = await chooseContext(frozen, resource, resolveComparison);
    if (!choice) { return undefined; }
    let comparison: Comparison | undefined;
    if (choice.input) {
      const { original, modified } = choice.input;
      comparison = comparisons.get(choice.input);
      if (original.toString() === modified.toString()) {
        void vscode.window.showInformationMessage('Both comparison sides use the same URI. The chosen capture side is preserved, but VS Code may display the review note on both sides.');
      }
    }
    const selectedUris = choice.input ? [choice.input.original, choice.input.modified] : [uri];
    const usesBase = (comparison ? [comparison.left, comparison.right] : [resource])
      .some(hasMutableOrigin);
    if (usesBase && captureChanged) { throw staleCapture(); }
    const validate = async (): Promise<void> => {
      let changed = false;
      const listener = repo.state.onDidChange(() => { changed = true; });
      const checked: { endpoint: vscode.Uri; resource: Resource }[] = [];
      try {
        if (usesBase && repo.state.HEAD?.commit !== baseCommit) { throw staleCapture(); }
        for (const endpoint of new Map(selectedUris.map(value => [value.toString(), value])).values()) {
          const captured = await resolve(endpoint);
          await git.validatedUri(captured.resource, repo);
          if (endpoint.scheme !== 'git') { continue; }
          // HEAD/index are mutable, including the '~' index-membership mapping. Do not
          // silently relabel a frozen buffer after the picker (or while a draft is open).
          if (hasMutableOrigin(captured.resource)) {
            const current = await git.resource(endpoint, repo);
            if (!current || current.origin !== captured.resource.origin || current.path !== captured.resource.path) {
              throw staleCapture();
            }
          }
          if (captured.text !== undefined) {
            const allowMissing = endpoint.toString() !== key && captured.text === '';
            const currentText = await git.content(captured.resource, repo, allowMissing);
            if (!sameRevisionText(captured.text, currentText)) { throw staleCapture(); }
          }
          checked.push({ endpoint, resource: captured.resource });
        }
        if (usesBase && (changed || repo.state.HEAD?.commit !== baseCommit)) { throw staleCapture(); }
        if (checked.some(value => !sameBaselineMapping(value.endpoint, value.resource, repo))) { throw staleCapture(); }
      } finally {
        listener.dispose();
      }
    };
    await validate();
    return {
      repo,
      uri,
      baseCommit,
      validate,
      comment: normalizeComment({
        ...resource,
        startLine: start + 1,
        endLine: end + 1,
        side: choice.side,
        comparison,
        anchorText,
        elided: selected.length > 20,
        body: '',
      }),
    };
  } catch (error) {
    await vscode.window.showWarningMessage(`Cannot capture review note: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  } finally {
    captureListener?.dispose();
  }
}

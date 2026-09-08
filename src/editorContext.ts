import * as path from 'node:path';
import * as vscode from 'vscode';
import { GitResources, Repository } from './git';
import { Comparison, normalizeComment, ReviewComment, Side } from './model';

export interface CapturedContext {
  repo: Repository;
  comment: ReviewComment;
  uri: vscode.Uri;
}

interface ContextChoice extends vscode.QuickPickItem {
  side: Side;
  input?: vscode.TabInputTextDiff;
}

function describe(uri: vscode.Uri): string {
  if (uri.scheme === 'file') { return `${uri.fsPath} (changed)`; }
  if (uri.scheme === 'git') {
    try {
      const query: unknown = JSON.parse(uri.query);
      if (query && typeof query === 'object' && 'path' in query && 'ref' in query
        && typeof query.path === 'string' && typeof query.ref === 'string') {
        const origin = query.ref === '~' ? 'baseline' : query.ref === '' ? 'staged'
          : query.ref === 'HEAD' || query.ref === 'head' ? 'head' : `ref: ${query.ref}`;
        return `${query.path} (${origin})`;
      }
    } catch { /* Malformed queries are explained by GitResources when selected. */ }
  }
  return uri.toString();
}

export async function captureContext(
  git: GitResources,
  uri: vscode.Uri,
  range: vscode.Range,
  options: {
    forceSidePrompt?: boolean;
    tabInput?: vscode.TabInputText | vscode.TabInputTextDiff;
    rangeSemantics?: 'selection' | 'thread';
  } = {},
): Promise<CapturedContext | undefined> {
  // Freeze all editor-derived state before Git initialization or any picker changes focus.
  // Native threads reach capture only at submission; draft-creation text cannot be recovered here.
  const key = uri.toString();
  const document = vscode.workspace.textDocuments.find(doc => !doc.isClosed && doc.uri.toString() === key);
  const text = document?.getText();
  const start = range.start.line;
  const end = options.rangeSemantics !== 'thread' && !range.isEmpty && range.end.character === 0
    ? range.end.line - 1 : range.end.line;
  const input = options.tabInput ?? vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  const forcePrompt = options.forceSidePrompt === true;
  const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs.map(tab => ({
    input: tab.input, label: tab.label, active: tab.isActive && group.isActive,
  })));

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
    const resource = await git.resource(uri, repo);
    if (!resource) { throw new Error('This document is not a supported file in the selected Git repository.'); }
    // When no buffer was open, read the selected resource before showing context UI.
    const capturedText = text ?? await git.content(resource, repo);
    const lines = capturedText.split(/\r\n|\n|\r/);
    if (start < 0 || end < start || end >= lines.length) {
      throw new Error('The captured line range is no longer available in this document. Select the source lines again.');
    }
    const eol = capturedText.includes('\r\n') ? '\r\n' : capturedText.includes('\n') ? '\n' : '\r';
    const selected = lines.slice(start, end + 1);
    const anchorText = (selected.length > 20 ? [...selected.slice(0, 10), '...', ...selected.slice(-5)] : selected).join(eol);
    let choice: ContextChoice | undefined;
    if (!forcePrompt && input instanceof vscode.TabInputTextDiff) {
      const left = input.original.toString() === key;
      const right = input.modified.toString() === key;
      if (left !== right) { choice = { label: '', side: left ? 'left' : 'right', input }; }
    } else if (!forcePrompt && input instanceof vscode.TabInputText && input.uri.toString() === key) {
      choice = { label: '', side: 'document' };
    }
    if (!choice) {
      const choices: ContextChoice[] = [{ label: `Document: ${path.basename(resource.path)}`,
        description: `${resource.path} (${resource.origin})`, detail: 'Regular document, without comparison context', side: 'document' }];
      const relevant = [...tabs];
      if (input instanceof vscode.TabInputTextDiff && !relevant.some(tab => tab.input === input)) {
        relevant.unshift({ input, label: 'Captured comparison', active: false });
      }
      for (const tab of relevant) {
        if (!(tab.input instanceof vscode.TabInputTextDiff)) { continue; }
        const diff = tab.input;
        for (const side of ['left', 'right'] as const) {
          const endpoint = side === 'left' ? diff.original : diff.modified;
          // Never transfer the captured range/text to the opposite or an unrelated URI.
          if (endpoint.toString() !== key) { continue; }
          choices.push({ label: `${side === 'left' ? 'Left / Original' : 'Right / Modified'}: ${path.basename(resource.path)}`,
            description: `${tab.label}${tab.active ? ' (active tab)' : ''} - ${resource.origin}`,
            detail: `Left: ${describe(diff.original)} -> Right: ${describe(diff.modified)}`,
            side, input: diff });
        }
      }
      choice = await vscode.window.showQuickPick(choices, {
        title: 'Confirm review note context',
        placeHolder: 'Choose the original capture context; the current tab is not assumed to be the source',
        ignoreFocusOut: true, matchOnDescription: true, matchOnDetail: true,
      });
      if (!choice) { return undefined; }
    }
    let comparison: Comparison | undefined;
    if (choice.input) {
      const { original, modified } = choice.input;
      const [leftRepo, rightRepo] = await Promise.all([git.repositoryFor(original), git.repositoryFor(modified)]);
      if (!leftRepo || !rightRepo || leftRepo.rootUri.toString() !== repo.rootUri.toString()
        || rightRepo.rootUri.toString() !== repo.rootUri.toString()) {
        throw new Error('Both comparison endpoints must be files in the same Git repository. Cross-repository comparisons are not supported.');
      }
      const [left, right] = await Promise.all([
        choice.side === 'left' ? resource : git.resource(original, repo),
        choice.side === 'right' ? resource : git.resource(modified, repo),
      ]);
      if (!left || !right) { throw new Error('This comparison contains an unsupported resource. Only file and Git text documents are supported.'); }
      comparison = { left, right };
      if (original.toString() === modified.toString()) {
        void vscode.window.showInformationMessage('Both comparison sides use the same URI. The chosen capture side is preserved, but VS Code may display the review note on both sides.');
      }
    }
    return { repo, uri, comment: normalizeComment({ ...resource, startLine: start + 1, endLine: end + 1,
      side: choice.side, comparison, anchorText, body: '' }) };
  } catch (error) {
    await vscode.window.showWarningMessage(`Cannot capture review note: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

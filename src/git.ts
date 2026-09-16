import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { normalizeResource, type Resource } from './model';
import { validateSingleFilePathspec } from './gitPath';

// Values from the bundled vscode.git API, not porcelain status letters.
const GitStatus = {
  IndexModified: 0,
  IndexAdded: 1,
  IndexDeleted: 2,
  IndexRenamed: 3,
  IndexCopied: 4,
  Modified: 5,
  Deleted: 6,
  Untracked: 7,
};

type FileCandidate = { uri: vscode.Uri; untracked: boolean; status?: number };
export type FileReviewCandidate = { path: string; uri: vscode.Uri; untracked: boolean };
type FileStatistics = { insertions?: number; deletions?: number };
type CachedStatistics = { signature: string; statistics: FileStatistics };
type StatisticsCache = {
  repo: Repository;
  event: vscode.Event<void>;
  candidates: Map<string, { path: string; untracked: boolean }>;
  entries: Map<string, CachedStatistics>;
};

export interface Repository {
  rootUri: vscode.Uri;
  state: {
    HEAD?: { commit?: string };
    indexChanges?: readonly { readonly uri: vscode.Uri; readonly status?: number }[];
    workingTreeChanges?: readonly { readonly uri: vscode.Uri; readonly status?: number }[];
    untrackedChanges?: readonly { readonly uri: vscode.Uri; readonly status?: number }[];
    mergeChanges?: readonly { readonly uri: vscode.Uri; readonly status?: number }[];
    submodules?: readonly { readonly path: string }[];
    onDidChange: vscode.Event<void>;
  };
  show(ref: string, path: string): Promise<string>;
  getCommit(ref: string): Promise<{ hash: string }>;
  getObjectDetails?(ref: string, path: string): Promise<{ mode: string; object: string; size: number }>;
  diffWithHEAD?(path: string): Promise<string>;
  add?(paths: string[]): Promise<void>;
  clean?(paths: string[]): Promise<void>;
}

interface GitAPI {
  readonly git?: { readonly path: string };
  readonly repositories: readonly Repository[];
  readonly state?: string;
  readonly onDidChangeState?: vscode.Event<string>;
  readonly onDidOpenRepository?: vscode.Event<Repository>;
  readonly onDidCloseRepository?: vscode.Event<Repository>;
}

interface GitExtension {
  readonly enabled?: boolean;
  getAPI(version: 1): GitAPI;
}

function unstagedCandidates(state: Repository['state']): Map<string, FileCandidate> {
  const entries = new Map<string, FileCandidate>();
  for (const change of state.workingTreeChanges ?? []) {
    const key = change.uri.toString();
    const untracked = change.status === GitStatus.Untracked || entries.get(key)?.untracked === true;
    entries.set(key, { uri: change.uri, untracked, status: change.status });
  }
  for (const change of state.untrackedChanges ?? []) {
    entries.set(change.uri.toString(), { uri: change.uri, untracked: true, status: change.status });
  }
  return entries;
}

function candidateMembership(repo: Repository): {
  read: (force?: boolean) => ReadonlyMap<string, FileCandidate>;
  dispose: () => void;
} {
  let entries: Map<string, FileCandidate> | undefined;
  let onDidChange: vscode.Event<void> | undefined;
  let listener: vscode.Disposable | undefined;
  const read = (force = false): ReadonlyMap<string, FileCandidate> => {
    // API wrappers and change arrays are freshly allocated by vscode.git 1.96.
    // Its event identity, not array identity, identifies the underlying state.
    // Always access live state so repository/access errors cannot be cached away.
    const state = repo.state;
    if (state.onDidChange !== onDidChange) {
      listener?.dispose();
      onDidChange = state.onDidChange;
      listener = onDidChange(() => { entries = undefined; });
      entries = undefined;
    }
    if (force || !entries) { entries = unstagedCandidates(state); }
    return entries;
  };
  return { read, dispose: () => listener?.dispose() };
}

function revisionRef(origin: Exclude<Resource['origin'], 'changed'>): string {
  switch (origin) {
    case 'staged':
      return '';
    case 'head':
      return 'HEAD';
    default:
      return origin.slice(7);
  }
}

async function trackedStatistics(repo: Repository, uri: vscode.Uri): Promise<FileStatistics> {
  // Despite its public name, VS Code 1.96 diffWithHEAD compares index to disk.
  const diffWithHEAD = repo.diffWithHEAD;
  if (!diffWithHEAD) { return {}; }

  const diff = await diffWithHEAD.call(repo, uri.fsPath);
  let insertions = 0;
  let deletions = 0;
  let oldRemaining = 0;
  let newRemaining = 0;
  let binary = false;
  for (const line of diff.split('\n')) {
    const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      oldRemaining = Number(hunk[1] ?? 1);
      newRemaining = Number(hunk[2] ?? 1);
      continue;
    }
    if (oldRemaining > 0 || newRemaining > 0) {
      switch (line[0]) {
        case '+':
          insertions++;
          newRemaining--;
          break;
        case '-':
          deletions++;
          oldRemaining--;
          break;
        case ' ':
          oldRemaining--;
          newRemaining--;
          break;
      }
    } else if (/^(?:Binary files .* differ|GIT binary patch)\r?$/.test(line)) {
      binary = true;
    }
  }
  return binary ? {} : { insertions, deletions };
}

async function statisticsSignature(
  repo: Repository, candidate: FileReviewCandidate, stat: vscode.FileStat | undefined, isCurrent: () => boolean,
): Promise<string | undefined> {
  // Missing metadata (including deleted files) cannot prove unchanged disk input.
  if (!stat || stat.type !== vscode.FileType.File || !Number.isFinite(stat.mtime)
    || !Number.isSafeInteger(stat.size) || stat.size < 0 || !isCurrent()) {
    return undefined;
  }
  const disk = [stat.type, stat.mtime, stat.size];
  if (candidate.untracked) { return JSON.stringify(['untracked', ...disk]); }

  // Resolve the live adapter outside the lookup catch: repository access errors
  // are ownership failures, not an optional statistics capability failure.
  const getObjectDetails = repo.getObjectDetails;
  if (!getObjectDetails || !repo.diffWithHEAD) { return undefined; }
  let details: Awaited<ReturnType<NonNullable<Repository['getObjectDetails']>>>;
  try {
    // VS Code 1.96 getObjectDetails('') uses ls-files --stage, not HEAD.
    details = await getObjectDetails.call(repo, '', candidate.uri.fsPath);
  } catch {
    // An unavailable index identity only disables reuse; still request a fresh diff.
    return undefined;
  }
  const { object, mode } = details;
  if (!isCurrent() || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(object)
    || !/^100(?:644|755)$/.test(mode)) {
    return undefined;
  }
  return JSON.stringify(['tracked', ...disk, object, mode]);
}

// Undefined invalidates only these statistics, never the published candidate list.
async function untrackedStatistics(
  uri: vscode.Uri, statistics: FileStatistics, validate: () => Promise<boolean>, isCurrent: () => boolean,
): Promise<FileStatistics | undefined> {
  if (!isCurrent()) { return undefined; }
  const stat = await vscode.workspace.fs.stat(uri);
  if (!await validate()) { return undefined; }
  if (stat.type !== vscode.FileType.File) { return undefined; }

  // Stat is only a preflight. The handle read has a hard byte budget even
  // if the file grows; one extra byte distinguishes an exact-limit file.
  const limit = 5 * 1024 * 1024;
  if (!(stat.size <= limit)) { return {}; }

  if (!isCurrent()) { return undefined; }
  const handle = await open(uri.fsPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!isCurrent()) { return undefined; }
    const opened = await handle.stat();
    if (!opened.isFile()) { return undefined; }
    if (opened.size > limit) { throw new Error('Untracked statistics exceed the read limit.'); }
    if (!await validate()) { return undefined; }

    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      if (!isCurrent()) { return undefined; }
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!isCurrent()) { return undefined; }
      if (!bytesRead) { break; }
      length += bytesRead;
    }
    const bytes = buffer.subarray(0, length);
    if (length > limit || bytes.subarray(0, 8000).includes(0)) { return {}; }

    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    let insertions = length && bytes[length - 1] !== 10 ? 1 : 0;
    for (const byte of bytes) {
      if (byte === 10) { insertions++; }
    }
    // Retain completed counts even if closing the handle subsequently fails.
    statistics.insertions = insertions;
    statistics.deletions = 0;
    return statistics;
  } finally {
    await handle.close();
  }
}

function source(uri: vscode.Uri): { file: vscode.Uri; ref?: string } | undefined {
  if (uri.scheme !== 'file' && uri.scheme !== 'git') { return undefined; }
  let file = uri;
  let ref: string | undefined;
  if (uri.scheme === 'git') {
    let query: unknown;
    try { query = JSON.parse(uri.query); }
    catch { throw new Error('Malformed Git URI: expected a JSON query with path and ref.'); }
    if (!query || typeof query !== 'object' || !('path' in query) || !('ref' in query)
      || typeof query.path !== 'string' || typeof query.ref !== 'string') {
      throw new Error('Malformed Git URI: path and ref must be strings.');
    }
    if ('submoduleOf' in query) {
      throw new Error('Submodule summary documents are not supported; open a file inside the submodule.');
    }
    if (!path.isAbsolute(query.path) || /[\x00-\x1f\x7f]/.test(query.path)
      || query.path.split(/[\\/]/).includes('..')) {
      throw new Error('Git URI path must be absolute and must not contain traversal.');
    }
    file = vscode.Uri.file(query.path);
    ref = query.ref;
    if (uri.authority !== file.authority) {
      throw new Error('Git URI authority does not match its file path.');
    }
  } else if (uri.query || uri.fragment) {
    throw new Error('File URIs with a query or fragment are not supported.');
  }
  if (path.sep === '/' && file.fsPath.includes('\\')) {
    throw new Error('Literal backslashes in filesystem paths cannot be represented losslessly in Review Notes.');
  }
  if (!path.isAbsolute(file.fsPath) || file.fsPath.split(/[\\/]/).includes('..')) {
    throw new Error('Expected an absolute file path without traversal.');
  }
  return { file, ref };
}

function relative(file: vscode.Uri, repo: Repository): string | undefined {
  if (repo.rootUri.scheme !== 'file' || file.authority !== repo.rootUri.authority) { return undefined; }
  if (path.sep === '/' && (file.fsPath.includes('\\') || repo.rootUri.fsPath.includes('\\'))) { return undefined; }
  const value = path.relative(repo.rootUri.fsPath, file.fsPath);
  if (path.isAbsolute(value) || value === '..' || value.startsWith(`..${path.sep}`)) { return undefined; }
  return value.split(path.sep).join('/');
}

export class GitResources implements vscode.Disposable {
  private readonly repositoryChanges = new vscode.EventEmitter<void>();
  readonly onDidChangeRepositories = this.repositoryChanges.event;
  private readonly subscriptions: vscode.Disposable[] = [];
  private api: GitAPI | undefined;
  private initialization: Promise<void> | undefined;
  private stopWaiting: (() => void) | undefined;
  private disposed = false;
  private readonly workspaceAdapters = new Map<string, Repository>();
  private statisticsCache: StatisticsCache | undefined;

  async initialize(): Promise<void> {
    if (this.disposed) { throw new Error('Git resources have been disposed.'); }
    if (!this.initialization) {
      this.initialization = (async () => {
        const extension = vscode.extensions.getExtension<GitExtension>('vscode.git');
        if (!extension) { throw new Error('The bundled VS Code Git extension is unavailable. Enable vscode.git.'); }
        const exports = await extension.activate();
        if (this.disposed) { throw new Error('Git resources have been disposed.'); }
        if (exports.enabled === false) { throw new Error('The VS Code Git extension is disabled. Enable Git and retry.'); }
        const api = exports.getAPI(1);
        if (api.state !== undefined && api.state !== 'initialized') {
          const onDidChangeState = api.onDidChangeState;
          if (!onDidChangeState) { throw new Error('The VS Code Git API is not initialized.'); }
          await new Promise<void>((resolve, reject) => {
            let listener: vscode.Disposable | undefined;
            const finish = (error?: Error): void => {
              listener?.dispose();
              this.stopWaiting = undefined;
              if (error) { reject(error); } else { resolve(); }
            };
            this.stopWaiting = () => finish(new Error('Git initialization was cancelled because resources were disposed.'));
            listener = onDidChangeState(state => { if (state === 'initialized') { finish(); } });
            if (api.state === 'initialized') { finish(); }
          });
        }
        if (this.disposed) { throw new Error('Git resources have been disposed.'); }
        this.api = api;
        if (api.onDidOpenRepository) { this.subscriptions.push(api.onDidOpenRepository(() => this.repositoryChanges.fire())); }
        if (api.onDidCloseRepository) { this.subscriptions.push(api.onDidCloseRepository(() => this.repositoryChanges.fire())); }
      })();
    }
    try {
      await this.initialization;
    } catch (error) {
      this.initialization = undefined;
      throw error;
    }
  }

  get repositories(): readonly Repository[] {
    return this.disposed ? [] : this.api?.repositories ?? [];
  }

  private containingRepository(file: vscode.Uri): Repository | undefined {
    return this.repositories.filter(repo => relative(file, repo) !== undefined)
      .sort((a, b) => b.rootUri.fsPath.length - a.rootUri.fsPath.length)[0];
  }

  private readonly pendingDirectoryStats = new Map<string, Thenable<vscode.FileStat>>();

  private async directoryStat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const key = uri.toString();
    const pending = this.pendingDirectoryStats.get(key);
    if (pending) {
      return pending;
    }
    // Share only in-flight parent/marker checks across a bounded candidate batch.
    // Settled results are never cached: later passes and mutations check afresh.
    const operation = vscode.workspace.fs.stat(uri);
    this.pendingDirectoryStats.set(key, operation);
    try {
      return await operation;
    } finally {
      this.pendingDirectoryStats.delete(key);
    }
  }

  private async withinRepository(file: vscode.Uri, repo: Repository, directory = false, shareDirectoryChecks = false): Promise<boolean> {
    const root = repo.rootUri.toString();
    const owned = (): boolean => {
      const owner = this.containingRepository(file);
      return owner?.rootUri.toString() === root && !owner.state.submodules?.some(submodule => {
        const boundary = vscode.Uri.joinPath(repo.rootUri, submodule.path);
        return relative(file, { ...repo, rootUri: boundary }) !== undefined;
      });
    };
    if (!owned()) { return false; }
    // Reject symlink traversal below the Git root, including in-scope aliases: Git
    // paths and saved paths must identify the same file. Missing paths remain valid
    // for deleted files and historical revisions. The root itself defines the scope.
    let current = file;
    while (current.toString() !== root) {
      if (relative(current, repo) === undefined) { return false; }
      try {
        const stat = shareDirectoryChecks && (directory || current.toString() !== file.toString())
          ? await this.directoryStat(current) : await vscode.workspace.fs.stat(current);
        if (stat.type & vscode.FileType.SymbolicLink) { return false; }
        if ((directory || current.toString() !== file.toString()) && stat.type !== vscode.FileType.Directory) {
          return false;
        }
      } catch (error) {
        if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'FileNotFound') {
          throw new Error('Cannot validate Git repository boundaries. Check filesystem access and retry.', { cause: error });
        }
      }
      // Closed/undiscovered repositories are absent from the Git API. Inspect only
      // their boundary marker metadata, never marker contents.
      if (directory || current.toString() !== file.toString()) {
        try {
          const marker = vscode.Uri.joinPath(current, '.git');
          if (shareDirectoryChecks) {
            await this.directoryStat(marker);
          } else {
            await vscode.workspace.fs.stat(marker);
          }
          return false;
        } catch (error) {
          if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'FileNotFound') {
            throw new Error('Cannot validate Git repository boundaries. Check filesystem access and retry.', { cause: error });
          }
        }
      }
      current = vscode.Uri.file(path.dirname(current.fsPath));
    }
    return owned();
  }

  async workspaceRepository(): Promise<Repository | undefined> {
    await this.initialize();
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!folder || folder.scheme !== 'file') { return undefined; }
    const repository = this.containingRepository(folder);
    if (!repository || !await this.withinRepository(folder, repository, true)
      || vscode.workspace.workspaceFolders?.[0]?.uri.toString() !== folder.toString()) { return undefined; }
    const root = repository.rootUri.toString();
    const key = JSON.stringify([root, folder.toString()]);
    let adapter = this.workspaceAdapters.get(key);
    if (!adapter) {
      // Git can return fresh wrappers. Keep folder identity stable, but metadata live.
      const actual = (): Repository => {
        const current = this.repositories.find(repo => repo.rootUri.toString() === root);
        if (!current) { throw new Error('The containing Git repository is no longer open. Refresh and retry.'); }
        return current;
      };
      adapter = {
        rootUri: folder,
        get state() { return actual().state; },
        show: (ref, filePath) => actual().show(ref, filePath),
        getCommit: ref => actual().getCommit(ref),
        get getObjectDetails() {
          const current = actual();
          return current.getObjectDetails?.bind(current);
        },
        get diffWithHEAD() {
          const current = actual();
          return current.diffWithHEAD?.bind(current);
        },
        get add() {
          const current = actual();
          return current.add?.bind(current);
        },
        get clean() {
          const current = actual();
          return current.clean?.bind(current);
        },
      };
      this.workspaceAdapters.set(key, adapter);
    }
    return adapter;
  }

  async repositoryFor(uri?: vscode.Uri, shareDirectoryChecks = false): Promise<Repository | undefined> {
    const file = uri ? source(uri)?.file : undefined;
    const repo = await this.workspaceRepository();
    if (!uri) { return repo; }
    if (!repo || !file || relative(file, repo) === undefined) { return undefined; }
    const actual = this.containingRepository(repo.rootUri);
    return actual && await this.withinRepository(file, actual, false, shareDirectoryChecks)
      && vscode.workspace.workspaceFolders?.[0]?.uri.toString() === repo.rootUri.toString() ? repo : undefined;
  }

  async resource(uri: vscode.Uri, repo: Repository): Promise<Resource | undefined> {
    const value = source(uri);
    if (!value) { return undefined; }
    const filePath = relative(value.file, repo);
    if (!filePath) { return undefined; }
    if (await this.repositoryFor(uri) !== repo) { return undefined; }
    const resource = normalizeResource({ path: filePath, origin: 'changed' });
    const ref = value.ref;
    if (ref === undefined) { return resource; }
    if (ref === '~') {
      // Match bundled Git's sanitizeRef: public change.uri is resourceUri, including renames.
      const indexed = repo.state.indexChanges?.some(change => change.uri.toString() === value.file.toString());
      return { ...resource, origin: indexed ? 'staged' : 'head' };
    }
    if (ref === '') { return { ...resource, origin: 'staged' }; }
    if (ref === 'HEAD' || ref === 'head') { return { ...resource, origin: 'head' }; }
    if (/^(?:~\d|:)/.test(ref) || ref.startsWith('-') || /[\x00-\x20\x7f]/.test(ref)) {
      throw new Error(`Unsupported Git ref ${JSON.stringify(ref)}: merge stages and non-commit revisions cannot be reviewed.`);
    }
    try {
      const commit = await repo.getCommit(ref);
      if (await this.repositoryFor(uri) !== repo) { return undefined; }
      return normalizeResource({ ...resource, origin: `commit:${commit.hash}` });
    } catch (error) {
      throw new Error(`Cannot resolve Git ref ${JSON.stringify(ref)} to a local commit: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }

  private currentFileScope(repo: Repository): boolean {
    return !this.disposed && vscode.workspace.workspaceFolders?.[0]?.uri.toString() === repo.rootUri.toString()
      && this.containingRepository(repo.rootUri) !== undefined;
  }

  private async validateFileCandidate(
    repo: Repository, candidate: FileReviewCandidate, isCurrent: () => boolean,
    observeStat?: (stat: vscode.FileStat) => void,
  ): Promise<boolean> {
    const current = (): boolean => isCurrent() && this.currentFileScope(repo);
    if (!current()) { return false; }
    if (await this.repositoryFor(candidate.uri, true) !== repo || !current()) { return false; }

    // Recheck the leaf after walking parents: source directories and unsupported
    // leaves are not candidates, even when Git still reports a change for them.
    try {
      const stat = await vscode.workspace.fs.stat(candidate.uri);
      observeStat?.(stat);
      return current() && stat.type === vscode.FileType.File;
    } catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'FileNotFound') {
        throw new Error('Cannot validate Git repository boundaries. Check filesystem access and retry.', { cause: error });
      }
      // Disk disappearance is not Git confirmation of removal from this list.
      // Mutation guards separately reject missing nondeleted action targets.
      return current();
    }
  }

  private retainStatistics(repo: Repository, candidates: readonly FileReviewCandidate[]): StatisticsCache {
    const event = repo.state.onDidChange;
    const previous = this.statisticsCache;
    const snapshot = new Map(candidates.map(candidate => [
      candidate.uri.toString(), { path: candidate.path, untracked: candidate.untracked },
    ]));
    const entries = new Map<string, CachedStatistics>();
    if (previous?.repo === repo && previous.event === event) {
      let identical = previous.candidates.size === snapshot.size;
      for (const [key, candidate] of snapshot) {
        const old = previous.candidates.get(key);
        if (old?.path !== candidate.path || old.untracked !== candidate.untracked) {
          identical = false;
          continue;
        }
        const cached = previous.entries.get(key);
        if (cached) { entries.set(key, cached); }
      }
      if (identical) { return previous; }
    }
    // Only a changed snapshot replaces identity, so identical editor refreshes
    // let current jobs finish caching while removed/reclassified paths stay evicted.
    const cache = { repo, event, candidates: snapshot, entries };
    this.statisticsCache = cache;
    return cache;
  }

  /** Host-only candidates; discovery never waits for diffs or source-content reads. */
  async filesToReview(
    repo: Repository, notedPaths: ReadonlySet<string>, excludedFolders: readonly vscode.Uri[] = [],
    isCurrent: () => boolean = () => true,
  ): Promise<FileReviewCandidate[]> {
    if (!isCurrent()) { return []; }
    const noted = new Set([...notedPaths].map(value => value.replace(/\\/g, '/')));
    if (await this.workspaceRepository() !== repo || !isCurrent()) { return []; }
    const current = (): boolean => isCurrent() && this.currentFileScope(repo);
    const membership = candidateMembership(repo);
    try {
      const pending: FileReviewCandidate[] = [];
      for (const { uri, untracked } of membership.read().values()) {
        if (excludedFolders.some(rootUri => relative(uri, { ...repo, rootUri }) !== undefined)) { continue; }
        try {
          if (uri.scheme !== 'file') { continue; }
          const name = path.basename(uri.fsPath);
          if (name === 'REVIEW-NOTES.md' || /^\.REVIEW-NOTES\.md\..*\.tmp$/.test(name)) { continue; }
          const value = source(uri);
          const filePath = value && relative(value.file, repo);
          if (!filePath) { continue; }
          const resource = normalizeResource({ path: filePath, origin: 'changed' });
          if (!noted.has(resource.path)) { pending.push({ path: resource.path, uri, untracked }); }
        } catch {
          // Unsupported URI/path shapes are exclusions, not failed discovery.
          continue;
        }
      }

      const validate = async (candidate: FileReviewCandidate): Promise<FileReviewCandidate | undefined> => {
        const valid = (): boolean => current()
          && membership.read().get(candidate.uri.toString())?.untracked === candidate.untracked;
        return await this.validateFileCandidate(repo, candidate, valid) ? candidate : undefined;
      };
      const rows: FileReviewCandidate[] = [];
      for (let offset = 0; offset < pending.length && current(); offset += 8) {
        const results = await Promise.allSettled(pending.slice(offset, offset + 8).map(validate));
        for (const result of results) {
          if (result.status === 'rejected') { throw result.reason; }
          if (result.value) { rows.push(result.value); }
        }
      }

      // Later batches may await while earlier files change ownership or membership.
      const verified: FileReviewCandidate[] = [];
      for (let offset = 0; offset < rows.length && current(); offset += 8) {
        const results = await Promise.allSettled(rows.slice(offset, offset + 8).map(validate));
        for (const result of results) {
          if (result.status === 'rejected') { throw result.reason; }
          if (result.value) { verified.push(result.value); }
        }
      }
      if (!current()) { return []; }
      // Git can update optimistically before its status event. Never publish using
      // only the event-invalidated lookup; capture the actual groups again here.
      const finalMembership = membership.read(true);
      const candidates = verified.filter(entry => finalMembership.get(entry.uri.toString())?.untracked === entry.untracked)
        .sort((a, b) => {
          if (a.path < b.path) { return -1; }
          if (a.path > b.path) { return 1; }
          return 0;
        });
      this.retainStatistics(repo, candidates);
      return candidates;
    } finally {
      membership.dispose();
    }
  }

  /** Missing counts do not remove candidates. force bypasses reuse for explicit refresh. */
  async fileStatistics(
    repo: Repository, candidates: readonly FileReviewCandidate[], isCurrent: () => boolean,
    force = false,
  ): Promise<Map<string, FileStatistics>> {
    const current = (): boolean => isCurrent() && this.currentFileScope(repo);
    if (!current()) { return new Map(); }
    const cache = this.retainStatistics(repo, candidates);
    if (force) { cache.entries.clear(); }
    const signatures = new Map<string, string>();
    const reused = new Set<string>();
    const membership = candidateMembership(repo);
    try {
      const readCandidate = async (candidate: FileReviewCandidate, fresh = force): Promise<FileStatistics | undefined> => {
        const key = candidate.uri.toString();
        const valid = (): boolean => current()
          && membership.read().get(candidate.uri.toString())?.untracked === candidate.untracked;
        let stat: vscode.FileStat | undefined;
        if (!await this.validateFileCandidate(repo, candidate, valid, value => { stat = value; })) { return; }
        // getObjectDetails does not expose the merge stage. Nonstandard working
        // states cannot prove the index object is the diff's complete baseline.
        if (!candidate.untracked && membership.read().get(key)?.status !== GitStatus.Modified) { stat = undefined; }
        const signature = await statisticsSignature(repo, candidate, stat, valid);
        if (!valid()) { return; }
        if (!candidate.untracked && stat && Number.isFinite(stat.mtime)
          && !await this.validateFileCandidate(repo, candidate, valid)) { return; }
        const cached = cache.entries.get(key);
        signatures.delete(key);
        reused.delete(key);
        if (!fresh && signature && cached?.signature === signature) {
          signatures.set(key, signature);
          reused.add(key);
          return { ...cached.statistics };
        }
        // A miss invalidates the old signature; a hit remains reusable if this
        // job is later cancelled before its final validation completes.
        cache.entries.delete(key);

        const statistics: FileStatistics = {};
        let succeeded = false;
        let validationFailure: { error: unknown } | undefined;
        try {
          if (candidate.untracked) {
            const result = await untrackedStatistics(candidate.uri, statistics, async () => {
              try {
                return await this.validateFileCandidate(repo, candidate, valid);
              } catch (error) {
                validationFailure = { error };
                throw error;
              }
            }, current);
            if (!result) { return; }
          } else {
            Object.assign(statistics, await trackedStatistics(repo, candidate.uri));
          }
          succeeded = true;
        } catch {
          // Ownership failures invalidate the batch, even if a later retry would succeed.
          if (validationFailure) { throw validationFailure.error; }
          // Statistics failures must not hide an otherwise reviewable file.
        }
        if (!await this.validateFileCandidate(repo, candidate, valid)) { return; }
        if (succeeded && signature && statistics.insertions !== undefined && statistics.deletions !== undefined) {
          signatures.set(key, signature);
        }
        return statistics;
      };

      // Drain each bounded batch on errors or cancellation before returning.
      const statistics = new Map<string, FileStatistics>();
      for (let offset = 0; offset < candidates.length && current(); offset += 8) {
        const batch = candidates.slice(offset, offset + 8);
        const results = await Promise.allSettled(batch.map(candidate => readCandidate(candidate)));
        for (const [index, result] of results.entries()) {
          if (result.status === 'rejected') { throw result.reason; }
          if (result.value) { statistics.set(batch[index].path, result.value); }
        }
      }
      const pending = candidates.filter(candidate => statistics.has(candidate.path));
      const verified: FileReviewCandidate[] = [];
      for (let offset = 0; offset < pending.length && current(); offset += 8) {
        const results = await Promise.allSettled(pending.slice(offset, offset + 8).map(async candidate => {
          const valid = (): boolean => current()
            && membership.read().get(candidate.uri.toString())?.untracked === candidate.untracked;
          const key = candidate.uri.toString();
          let stat: vscode.FileStat | undefined;
          if (!await this.validateFileCandidate(repo, candidate, valid, value => { stat = value; })) { return; }
          if (!candidate.untracked && membership.read().get(key)?.status !== GitStatus.Modified) { stat = undefined; }
          const before = signatures.get(key);
          if (before) {
            const after = await statisticsSignature(repo, candidate, stat, valid);
            const observed = stat;
            let finalStat: vscode.FileStat | undefined;
            if (!await this.validateFileCandidate(repo, candidate, valid, value => { finalStat = value; })) { return; }
            // Index lookup awaits too: recheck disk metadata and ownership after it.
            if (before !== after || !finalStat || !observed || finalStat.type !== observed.type
              || finalStat.mtime !== observed.mtime || finalStat.size !== observed.size) {
              signatures.delete(key);
              if (cache.entries.get(key)?.signature === before) { cache.entries.delete(key); }
              if (reused.has(key)) {
                const fresh = await readCandidate(candidate, true);
                signatures.delete(key); // A raced cache hit is retried, never cached this pass.
                if (!fresh) { return; }
                statistics.set(candidate.path, fresh);
              }
            }
          }
          return candidate;
        }));
        for (const result of results) {
          if (result.status === 'rejected') { throw result.reason; }
          if (result.value) { verified.push(result.value); }
        }
      }
      if (!current()) { return new Map(); }
      const finalMembership = membership.read(true);
      const result = new Map<string, FileStatistics>();
      for (const key of cache.entries.keys()) {
        if (finalMembership.get(key)?.untracked !== cache.candidates.get(key)?.untracked) {
          cache.entries.delete(key);
        }
      }
      for (const candidate of verified) {
        if (finalMembership.get(candidate.uri.toString())?.untracked === candidate.untracked) {
          const counts = statistics.get(candidate.path) ?? {};
          result.set(candidate.path, counts);
          const key = candidate.uri.toString();
          const signature = signatures.get(key);
          const cacheable = candidate.untracked || finalMembership.get(key)?.status === GitStatus.Modified;
          if (signature && cacheable && this.statisticsCache === cache && repo.state.onDidChange === cache.event) {
            cache.entries.set(key, { signature, statistics: { ...counts } });
          }
        }
      }
      return result;
    } finally {
      membership.dispose();
    }
  }

  /** Reviewer-authorized whole-file staging; validate rechecks the host's live action guard. */
  async stageFile(repo: Repository, filePath: string, notedPaths: ReadonlySet<string>,
    excludedFolders: readonly vscode.Uri[], validate: () => void): Promise<void> {
    return this.mutateFile('stage', repo, filePath, notedPaths, excludedFolders, validate);
  }

  /** Reviewer-authorized index-preserving revert; confirmation is supplied here or already held by the host. */
  async revertFile(repo: Repository, filePath: string, notedPaths: ReadonlySet<string>,
    excludedFolders: readonly vscode.Uri[], validate: () => void,
    confirm?: (untracked: boolean) => Promise<boolean>): Promise<void> {
    return this.mutateFile('revert', repo, filePath, notedPaths, excludedFolders, validate, confirm);
  }

  private async mutateFile(action: 'stage' | 'revert', repo: Repository, filePath: string, notedPaths: ReadonlySet<string>,
    excludedFolders: readonly vscode.Uri[], validate: () => void,
    confirm?: (untracked: boolean) => Promise<boolean>): Promise<void> {
    const label = action === 'stage' ? 'Stage File' : 'Revert File';
    if (path.sep === '/' && filePath.includes('\\')) {
      throw new Error(`${label} requires a losslessly represented filesystem path without literal backslashes.`);
    }
    const resource = normalizeResource({ path: filePath, origin: 'changed' });
    if (/[*?]/.test(resource.path)) {
      throw new Error(`${label} requires one literal file path, not a wildcard.`);
    }
    const uri = this.uri(resource, repo);
    const candidate = () => {
      if (this.disposed || vscode.workspace.workspaceFolders?.[0]?.uri.toString() !== repo.rootUri.toString()) {
        throw new Error('The opened folder has changed. Refresh Files to Review and retry.');
      }
      const name = path.posix.basename(resource.path);
      if (name === 'REVIEW-NOTES.md' || /^\.REVIEW-NOTES\.md\..*\.tmp$/.test(name)
        || excludedFolders.some(rootUri => relative(uri, { ...repo, rootUri }) !== undefined)) {
        throw new Error(`Review Notes, temporary review files and archive storage cannot be ${action === 'stage' ? 'staged' : 'reverted'}.`);
      }
      if ([...notedPaths].some(value => value.replace(/\\/g, '/') === resource.path)) {
        throw new Error('This file has saved Review Notes and is no longer a Files to Review candidate.');
      }
      const matches = (change: { uri: vscode.Uri }): boolean => change.uri.toString() === uri.toString();
      const changes = [
        ...(repo.state.workingTreeChanges ?? []).filter(matches).map(change => ({ uri: change.uri, status: change.status, untracked: false })),
        ...(repo.state.untrackedChanges ?? []).filter(matches).map(change => ({ uri: change.uri, status: change.status, untracked: true })),
      ];
      if (!changes.length) {
        throw new Error('This file no longer has unstaged or untracked changes. Refresh Files to Review and retry.');
      }
      if (action === 'revert') {
        if (vscode.workspace.textDocuments.some(doc => !doc.isClosed && doc.isDirty && doc.uri.toString() === uri.toString())) {
          throw new Error('Revert File cannot discard a file with unsaved changes. Save or close the dirty document and retry.');
        }
        // Git clean may unstage intent-to-add or conflicted resources. Only these
        // explicit working-tree statuses safely restore the index or delete untracked files.
        const restorableStatuses = [GitStatus.Modified, GitStatus.Deleted, GitStatus.Untracked];
        const standardIndexStatuses = [GitStatus.IndexModified, GitStatus.IndexAdded, GitStatus.IndexDeleted,
          GitStatus.IndexRenamed, GitStatus.IndexCopied];
        const unsupportedWorkingChange = changes.some(change => change.status === undefined
          || !restorableStatuses.includes(change.status)
          || (change.untracked && change.status !== GitStatus.Untracked));
        const conflicted = repo.state.mergeChanges?.some(matches);
        const unsupportedIndexChange = repo.state.indexChanges?.some(change => matches(change)
          && (change.status === undefined || !standardIndexStatuses.includes(change.status)));
        if (unsupportedWorkingChange || conflicted || unsupportedIndexChange) {
          throw new Error('Revert File does not support this Git status, including conflicts and intent-to-add. Refresh and retry.');
        }
      }
      return {
        uri: changes[0].uri,
        deleted: changes.some(change => change.status === GitStatus.Deleted),
        untracked: changes.some(change => change.status === GitStatus.Untracked),
        kind: changes.map(change => `${change.untracked}:${change.status}`).sort().join(','),
      };
    };
    const initial = candidate();
    await this.validatedUri(resource, repo);
    const checkFile = async (): Promise<boolean> => {
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.type !== vscode.FileType.File) {
          throw new Error(`${label} requires a regular file, not a directory or symbolic link.`);
        }
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'FileNotFound') {
          return true;
        }
        throw new Error(`Cannot ${action} ${resource.path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
      return false;
    };
    let missing = await checkFile();
    if (confirm) {
      validate();
      const current = candidate();
      if (current.kind !== initial.kind || (missing && !current.deleted)) {
        throw new Error('The Git candidate changed. Refresh Files to Review and retry.');
      }
      if (!await confirm(initial.untracked)) { return; }
      validate();
      candidate();
      missing = await checkFile();
    }
    await this.validatedUri(resource, repo);
    missing = await checkFile();
    if (/[\[\]]/.test(resource.path)) {
      // The bundled Git API accepts filesystem paths, not escaped pathspecs.
      // Brackets are valid filenames, but Git can also expand them to siblings.
      const repository = this.containingRepository(uri);
      const gitPath = this.api?.git?.path;
      if (!repository || !gitPath) {
        throw new Error('Cannot verify this filename with the containing Git repository. Refresh and retry.');
      }
      await validateSingleFilePathspec(gitPath, repository.rootUri.fsPath, uri.fsPath);
      await this.validatedUri(resource, repo);
      missing = await checkFile();
    }
    // Keep the host guard, live membership checks and Git invocation in one synchronous turn.
    validate();
    const current = candidate();
    if (action === 'revert' && current.kind !== initial.kind) {
      throw new Error('The Git candidate kind or status has changed. Refresh Files to Review and retry.');
    }
    if (missing && !current.deleted) {
      throw new Error(`Only a deleted Git candidate can be ${action === 'stage' ? 'staged' : 'reverted'} when its file is missing.`);
    }
    // VS Code 1.96 clean restores tracked files from the index, preserving staged
    // changes, and deletes untracked files. Repository.revert would unstage instead.
    const mutate = action === 'stage' ? repo.add : repo.clean;
    if (!mutate) { throw new Error(`The containing Git repository does not support ${label}. Refresh and retry.`); }
    await mutate.call(repo, [current.uri.fsPath]);
  }

  uri(resource: Resource, repo: Repository): vscode.Uri {
    const normalized = normalizeResource(resource);
    if (repo.rootUri.scheme !== 'file') { throw new Error('Only local Git repository resources are supported.'); }
    const file = vscode.Uri.joinPath(repo.rootUri, normalized.path);
    const owner = this.containingRepository(file);
    const actual = this.containingRepository(repo.rootUri) ?? repo;
    if (owner && owner.rootUri.toString() !== actual.rootUri.toString()) {
      throw new Error('The resource belongs to a nested repository, not the selected repository.');
    }
    if (normalized.origin === 'changed') { return file; }
    const ref = revisionRef(normalized.origin);
    return vscode.Uri.from({ scheme: 'git', authority: file.authority, path: file.path,
      query: JSON.stringify({ path: file.fsPath, ref }) });
  }

  /** Use for navigation; uri() only constructs a URI and cannot check filesystem boundaries. */
  async validatedUri(resource: Resource, repo: Repository): Promise<vscode.Uri> {
    const uri = this.uri(resource, repo);
    if (await this.repositoryFor(uri) !== repo) {
      throw new Error('The resource is outside the opened folder or crosses a Git repository boundary. Refresh and retry.');
    }
    return uri;
  }

  async content(resource: Resource, repo: Repository, allowMissing = false): Promise<string> {
    const uri = await this.validatedUri(resource, repo);
    try {
      let text: string;
      if (uri.scheme === 'file') {
        const document = vscode.workspace.textDocuments.find(doc => !doc.isClosed && doc.uri.toString() === uri.toString());
        if (document) { return document.getText(); }
        text = new TextDecoder('utf-8', { fatal: true }).decode(await vscode.workspace.fs.readFile(uri));
      } else {
        const revision = source(uri);
        if (!revision || revision.ref === undefined) {
          throw new Error('Expected a Git revision URI.');
        }
        const filePath = revision.file.fsPath;
        const ref = revision.ref;
        try { text = await repo.show(ref, filePath); }
        catch (error) {
          if (!allowMissing || !repo.getObjectDetails) { throw error; }
          if (error && typeof error === 'object' && 'gitErrorCode' in error
            && error.gitErrorCode !== undefined && error.gitErrorCode !== 'UnknownPath') { throw error; }
          // show() has no reliable missing-path code. The bundled Git API emits
          // UnknownPath only after a successful ls-tree/ls-files finds no entry.
          try { await repo.getObjectDetails(ref, filePath); }
          catch (detailsError) {
            if (!detailsError || typeof detailsError !== 'object'
              || !('gitErrorCode' in detailsError) || detailsError.gitErrorCode !== 'UnknownPath') { throw detailsError; }
            await this.validatedUri(resource, repo);
            return '';
          }
          throw error;
        }
      }
      await this.validatedUri(resource, repo);
      return text;
    } catch (error) {
      throw new Error(`Cannot read ${resource.path} (${resource.origin}): ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }

  dispose(): void {
    this.disposed = true;
    this.stopWaiting?.();
    this.api = undefined;
    this.workspaceAdapters.clear();
    this.statisticsCache = undefined;
    this.subscriptions.forEach(item => item.dispose());
    this.repositoryChanges.dispose();
  }
}

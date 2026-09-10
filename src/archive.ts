import { createHash, randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { parse } from './parser';
import { assertUtf8Text } from './writer';

export interface ReviewArchive {
  id: string;
  createdAt: string;
  // Historical metadata: parser evolution may change how many notes the text yields today.
  commentCount: number;
}

interface ArchiveRecord extends ReviewArchive {
  version: 1;
  repoUri: string;
  text: string;
}

function validateRecord(record: unknown, id: string, repoUri: string): ArchiveRecord {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error('Invalid review archive record.');
  }
  const value = record as Record<string, unknown>;
  const { version, id: recordId, repoUri: recordUri, text, createdAt, commentCount } = value;
  if (version !== 1 || recordUri !== repoUri || recordId !== id) {
    throw new Error('Invalid review archive metadata or content.');
  }
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('Invalid review archive metadata or content.');
  }
  if (typeof createdAt !== 'string' || !Number.isFinite(Date.parse(createdAt))
    || new Date(createdAt).toISOString() !== createdAt) {
    throw new Error('Invalid review archive metadata or content.');
  }
  if (typeof commentCount !== 'number' || !Number.isSafeInteger(commentCount) || commentCount < 0) {
    throw new Error('Invalid review archive metadata or content.');
  }
  assertUtf8Text(text);

  return { version, id: recordId, repoUri: recordUri, text, createdAt, commentCount };
}

export class ReviewArchives {
  private readonly directory: vscode.Uri;
  private readonly repoUri: string;
  private metadata = new Map<string, { mtime: number; size: number; archive: ReviewArchive }>();
  private listing: Promise<ReviewArchive[]> | undefined;
  private generation = 0;

  constructor(storageUri: vscode.Uri, repoUri: vscode.Uri) {
    this.repoUri = repoUri.toString();
    const hash = createHash('sha256').update(this.repoUri).digest('hex');
    this.directory = vscode.Uri.joinPath(storageUri, 'reviews', hash);
  }

  private uri(id: string): vscode.Uri {
    // Only canonical randomUUID IDs are accepted, never paths or encoded paths.
    if (typeof id !== 'string' || id.length !== 36
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) {
      throw new Error('Invalid review archive ID.');
    }
    return vscode.Uri.joinPath(this.directory, `${id}.json`);
  }

  private async record(id: string, knownStat?: vscode.FileStat): Promise<ArchiveRecord> {
    const uri = this.uri(id);
    const stat = knownStat ?? await vscode.workspace.fs.stat(uri);
    if (!(stat.type & vscode.FileType.File) || (stat.type & vscode.FileType.SymbolicLink)) {
      throw new Error('Review archive is not a regular file.');
    }
    const bytes = await vscode.workspace.fs.readFile(uri);
    let record: unknown;
    try {
      record = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
      throw new Error('Invalid review archive JSON or encoding.');
    }
    return validateRecord(record, id, this.repoUri);
  }

  async list(): Promise<ReviewArchive[]> {
    if (!this.listing) {
      this.listing = (async () => {
        let generation: number;
        let archives: ReviewArchive[];
        do {
          generation = this.generation;
          archives = await this.scan(generation);
        } while (generation !== this.generation);
        return archives;
      })().finally(() => {
        this.listing = undefined;
      });
    }
    return (await this.listing).map(archive => ({ ...archive }));
  }

  private async scan(generation: number): Promise<ReviewArchive[]> {
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(this.directory);
    } catch (error) {
      if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') {
        if (generation === this.generation) {
          this.metadata.clear();
        }
        return [];
      }
      throw error;
    }

    const archives: ReviewArchive[] = [];
    const metadata: typeof this.metadata = new Map();
    for (const [name] of entries) {
      if (!name.endsWith('.json')) {
        continue;
      }
      try {
        const id = name.slice(0, -5);
        const uri = this.uri(id);
        const stat = await vscode.workspace.fs.stat(uri);
        if (!(stat.type & vscode.FileType.File) || (stat.type & vscode.FileType.SymbolicLink)) {
          throw new Error('Review archive is not a regular file.');
        }

        const cached = this.metadata.get(id);
        if (cached && cached.mtime === stat.mtime && cached.size === stat.size) {
          metadata.set(id, cached);
          archives.push(cached.archive);
        } else {
          const { createdAt, commentCount } = await this.record(id, stat);
          const archive = { id, createdAt, commentCount };
          const after = await vscode.workspace.fs.stat(uri);
          if (after.type === stat.type && after.mtime === stat.mtime && after.size === stat.size) {
            metadata.set(id, { mtime: stat.mtime, size: stat.size, archive });
          }
          archives.push(archive);
        }
      } catch (error) {
        console.warn(`Skipping invalid review archive ${name}:`, error);
      }
    }

    if (generation === this.generation) {
      this.metadata = metadata;
    }
    // Limit only the display, not retention; older IDs remain recoverable.
    return archives.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)
      || b.id.localeCompare(a.id)).slice(0, 10);
  }

  async save(text: string): Promise<ReviewArchive> {
    if (!text.trim()) {
      throw new Error('Cannot archive empty review feedback.');
    }
    assertUtf8Text(text);

    const parsed = parse(text);
    const archive: ReviewArchive = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      commentCount: parsed.comments.length + parsed.generalNotes.length,
    };
    const record: ArchiveRecord = { version: 1, repoUri: this.repoUri, ...archive, text };
    const destination = this.uri(archive.id);
    const temporary = vscode.Uri.joinPath(this.directory, `${archive.id}.${randomUUID()}.tmp`);

    await vscode.workspace.fs.createDirectory(this.directory);
    try {
      await vscode.workspace.fs.writeFile(temporary, new TextEncoder().encode(JSON.stringify(record)));
      await vscode.workspace.fs.rename(temporary, destination, { overwrite: false });
      this.generation++;
    } catch (error) {
      try {
        await vscode.workspace.fs.delete(temporary, { recursive: false, useTrash: false });
      } catch (cleanupError) {
        if (!(cleanupError instanceof vscode.FileSystemError && cleanupError.code === 'FileNotFound')) {
          console.warn('Could not remove temporary review archive:', cleanupError);
        }
      }
      throw error;
    }
    return archive;
  }

  async read(id: string): Promise<string> {
    return (await this.record(id)).text;
  }
}

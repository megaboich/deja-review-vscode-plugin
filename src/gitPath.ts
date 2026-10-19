import { execFile } from 'node:child_process';
import * as path from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);

/**
 * Check Git's pathspec expansion without reading source or changing the index.
 *
 * Square brackets are valid filename characters but also pathspec wildcards, so
 * `a[1].ts` can match siblings. The API takes filesystem paths, so escaping is not an
 * option: instead require Git itself to resolve this path to exactly one tracked or
 * untracked file before any single-file add/clean. This narrows but cannot eliminate
 * the race with external filesystem changes. Literal `*`/`?` names stay unsupported.
 */
export async function validateSingleFilePathspec(gitPath: string, repositoryRoot: string, filePath: string): Promise<void> {
  let output: string;
  try {
    const result = await execute(gitPath, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', filePath], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    output = result.stdout;
  } catch {
    throw new Error('Cannot verify that Git targets only this file. Refresh Files to Review and retry.');
  }

  const matches = new Set(output.split('\0').filter(value => value !== ''));
  const expected = path.relative(repositoryRoot, filePath).split(path.sep).join('/');
  if (matches.size !== 1 || !matches.has(expected)) {
    throw new Error('Git could match other files for this filename. The single-file action was cancelled.');
  }
}

/**
 * Read one stage-0 index entry with a single literal-pathspec Git process. The bundled
 * API's getObjectDetails('') spawns two (ls-files plus an unused cat-file size lookup)
 * and treats brackets as wildcards. Undefined means absent, conflicted or unexpected.
 */
export async function indexEntry(gitPath: string, repositoryRoot: string, filePath: string)
  : Promise<{ mode: string; object: string } | undefined> {
  const { stdout } = await execute(gitPath, ['--literal-pathspecs', 'ls-files', '--stage', '-z', '--', filePath], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 64 * 1024,
  });
  const records = stdout.split('\0').filter(value => value !== '');
  const match = records.length === 1 ? /^(\d{6}) ([0-9a-f]{40}|[0-9a-f]{64}) 0\t([^]*)$/.exec(records[0]) : null;
  const expected = path.relative(repositoryRoot, filePath).split(path.sep).join('/');
  if (!match || match[3] !== expected) {
    return undefined;
  }
  return { mode: match[1], object: match[2] };
}

import { execFile } from 'node:child_process';
import * as path from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);

/** Check Git's pathspec expansion without reading source or changing the index. */
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

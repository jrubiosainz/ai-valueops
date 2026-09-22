import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

export const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));
export const sha256 = (value) => createHash('sha256').update(value).digest('hex');

export function withinRoot(path, root = ROOT) {
  const target = resolve(root, path);
  if (!target.startsWith(`${resolve(root)}${sep}`)) throw new Error('Path must remain inside the project directory.');
  return target;
}

export async function readProjectFile(path, root = ROOT) {
  const [actualRoot, actual] = await Promise.all([realpath(root), realpath(withinRoot(path, root))]);
  if (!actual.startsWith(`${actualRoot}${sep}`)) throw new Error('File symlink escapes the project directory.');
  return readFile(actual);
}

export const readJson = async (path) => JSON.parse(await readProjectFile(path));

export async function writeLocal(path, value) {
  if (!/^\.local\/[a-zA-Z0-9./_-]+$/.test(path) || path.split('/').includes('..')) {
    throw new Error('Run output must stay inside .local.');
  }
  const target = withinRoot(path);
  await mkdir(dirname(target), { recursive: true });
  const [parent, root] = await Promise.all([realpath(dirname(target)), realpath(ROOT)]);
  if (!parent.startsWith(`${root}${sep}`)) throw new Error('Output directory escapes the project.');
  if (existsSync(target)) {
    const actual = await realpath(target);
    if (!actual.startsWith(`${root}${sep}`)) throw new Error('Output file escapes the project.');
  }
  await writeFile(target, value, { mode: 0o600 });
}

export const writeLocalJson = (path, value) => writeLocal(path, `${JSON.stringify(value, null, 2)}\n`);

export function sourceCommit({ required = false, root = ROOT } = {}) {
  if (!existsSync(resolve(root, '.git'))) {
    if (required) throw new Error('A committed Git checkout is required for a live evaluation.');
    return null;
  }
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new Error('Cannot identify the checked-out source commit.');
  return commit;
}

export function inputsCommitted(paths, { root = ROOT } = {}) {
  if (!existsSync(resolve(root, '.git'))) return false;
  const tracked = execFileSync('git', ['ls-files', '-z', '--', ...paths], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).split('\0').filter(Boolean);
  if (paths.some((path) => !tracked.includes(path))) return false;
  const changes = execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '--', ...paths], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  return changes.length === 0;
}

export function assertCommittedInputs(paths) {
  sourceCommit({ required: true });
  if (!inputsCommitted(paths)) throw new Error('Commit all evaluator inputs and the price snapshot before a live evaluation.');
}

export async function inputHashes() {
  const paths = [
    'samples/corpus.json', 'samples/gold.json', 'config/experiment.json', 'config/service.json', 'config/pricing.json',
    'src/retrieval.mjs', 'src/qa-service.mjs', 'src/evidence.mjs', 'src/foundry.mjs',
    'src/files.mjs', 'src/config.mjs', 'scripts/azure.mjs', 'scripts/evaluate.mjs',
  ];
  return Object.fromEntries(await Promise.all(paths.map(async (path) => [path, sha256(await readProjectFile(path))])));
}

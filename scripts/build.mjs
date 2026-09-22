import { mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve, dirname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, readProjectFile, sha256, inputHashes, inputsCommitted, sourceCommit, withinRoot } from '../src/files.mjs';
import { loadInputs } from '../src/config.mjs';
import { assertEvidence, assertReportCalculations, loadRecorded } from '../src/public-contract.mjs';
import { reportFailure } from './azure.mjs';

const WEB_FILES = ['index.html', 'styles.css', 'app.mjs', 'format.mjs', 'staticwebapp.config.json'];
const DATA_FILES = ['samples/corpus.json', 'samples/gold.json', 'samples/pricing.json', 'config/experiment.json', 'config/service.json'];

export async function build({ reportPath = 'samples/recorded.json', directory = resolve(ROOT, 'dist') } = {}) {
  const target = resolve(directory);
  if (target !== resolve(ROOT, 'dist') && !target.startsWith(`${resolve(ROOT, '.local')}${sep}`)) {
    throw new Error('Build output must be dist or a test directory inside .local.');
  }
  const { config, gold, service } = await loadInputs();
  let report;
  let bytes;
  if (reportPath === 'samples/recorded.json') {
    ({ report, bytes } = await loadRecorded());
  } else {
    if (!/^\.local\/runs\/[a-zA-Z0-9.-]+\.json$/.test(reportPath)) throw new Error('Select a local evaluation report inside .local/runs.');
    bytes = await readProjectFile(reportPath);
    report = assertEvidence(JSON.parse(bytes));
    if (report.executionMode === 'recorded-azure') throw new Error('Use the bundled checksum-verified file for the recorded example.');
    const actualHashes = await inputHashes();
    if (JSON.stringify(report.inputs.hashes) !== JSON.stringify(actualHashes)) {
      throw new Error('Evaluator input drift since this report. Use the matching inputs or run a new evaluation; do not relabel the report.');
    }
  }
  assertReportCalculations(report, config, gold);
  const files = new Map(await Promise.all([
    ...WEB_FILES.map(async (name) => [name, await readProjectFile(`public/${name}`)]),
    ...DATA_FILES.map(async (name) => [name, await readProjectFile(name)]),
  ]));
  files.set('evidence.json', bytes);
  files.set('api/evidence', bytes);
  if (reportPath === 'samples/recorded.json') files.set('samples/recorded.json', bytes);
  if (report.proposal.eligible) {
    const patch = await readProjectFile(`.local/proposals/${report.runId}.patch`);
    if (sha256(patch) !== report.proposal.sha256) throw new Error('Proposed patch digest does not match the report.');
    files.set('proposal.patch', patch);
  }
  const sourcePaths = [...WEB_FILES.map((name) => `public/${name}`), ...DATA_FILES, 'scripts/build.mjs',
    'src/files.mjs', 'src/config.mjs', 'src/public-contract.mjs', 'src/evidence.mjs', 'src/qa-service.mjs', 'src/retrieval.mjs'];
  const health = {
    status: 'ok', productId: 'ai-valueops', serving: 'read-only-report', language: 'en',
    uiSourceCommit: sourceCommit(), uiInputsCommitted: inputsCommitted(sourcePaths),
    executionMode: report.executionMode, executedSourceCommit: report.sourceCommit,
    runId: report.runId, evidenceSha256: sha256(bytes), evidenceGeneratedAt: report.generatedAt,
    builtAt: new Date().toISOString(), publicInference: false, mutableEndpoints: false,
  };
  const manifest = {
    productId: 'ai-valueops', title: 'AI ValueOps', readOnly: true, activeService: service,
    reportSha256: health.evidenceSha256, uiSourceCommit: health.uiSourceCommit,
    uiInputsCommitted: health.uiInputsCommitted,
    assetsSha256: Object.fromEntries([...files].map(([path, value]) => [path, sha256(value)])),
  };
  for (const [name, value] of [['health', health], ['manifest', manifest]]) {
    const data = `${JSON.stringify(value, null, 2)}\n`;
    files.set(`api/${name}`, data);
    files.set(`${name}.json`, data);
  }
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  for (const [name, content] of files) {
    const destination = withinRoot(name, target);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, content);
  }
  console.log(`Built ${report.executionMode} read-only viewer. No model calls or configuration changes.`);
  return { directory: target, health, manifest };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.length !== 0 && (args.length !== 2 || args[0] !== '--report')) {
    reportFailure(new Error('Usage: npm run build [-- --report .local/runs/<run>.json]. Default: bundled recorded example.'));
  } else {
    build(args.length ? { reportPath: args[1] } : {}).catch(reportFailure);
  }
}

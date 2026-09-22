import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT, sourceCommit, inputsCommitted, withinRoot } from '../src/files.mjs';
import { loadInputs, validateInputs } from '../src/config.mjs';

test('only bounded, versioned synthetic workloads with mandatory policy are accepted', async () => {
  const source = await loadInputs();
  assert.doesNotThrow(() => validateInputs(source));
  for (const mutate of [
    (inputs) => { inputs.corpus.classification = 'customer'; },
    (inputs) => { inputs.gold.version = 'unknown'; },
    (inputs) => { inputs.config.thresholds.minimumPolicyRate = 0; },
    (inputs) => { inputs.config.thresholds.minimumAttributionCoverage = 0.9; },
    (inputs) => { inputs.config.thresholds.minimumQualityRate = 0; },
    (inputs) => { inputs.config.thresholds.maximumPriceAgeDays = Infinity; },
    (inputs) => { inputs.config.maxRequests = 2; },
    (inputs) => { inputs.config.repetitions = -1; },
    (inputs) => { inputs.config.requestIntervalMs = NaN; },
    (inputs) => { inputs.config.mandatoryDocumentIds = []; },
    (inputs) => { inputs.corpus.documents.push(inputs.corpus.documents[0]); },
    (inputs) => { inputs.gold.cases = []; },
    (inputs) => { inputs.gold.cases.push(inputs.gold.cases[0]); },
    (inputs) => { inputs.gold.cases[0].question = '   '; },
    (inputs) => { inputs.service.strategy = 'aggressive'; },
  ]) {
    const inputs = structuredClone(source);
    mutate(inputs);
    assert.throws(() => validateInputs(inputs));
  }
});

test('a Gitless copy cannot borrow an enclosing repository identity; staged files are not committed', async () => {
  await mkdir(resolve(ROOT, '.local'), { recursive: true });
  const directory = await mkdtemp(resolve(ROOT, '.local/provenance-test-'));
  try {
    assert.equal(sourceCommit({ root: directory }), null);
    assert.throws(() => sourceCommit({ root: directory, required: true }), /committed Git checkout/);
    assert.equal(inputsCommitted(['input.json'], { root: directory }), false);
    await writeFile(resolve(directory, 'input.json'), '{}');
    execFileSync('git', ['init', '--quiet', directory]);
    assert.equal(inputsCommitted(['input.json'], { root: directory }), false);
    execFileSync('git', ['-C', directory, 'add', 'input.json']);
    assert.equal(inputsCommitted(['input.json'], { root: directory }), false);
    assert.throws(() => withinRoot('../outside', directory), /inside/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

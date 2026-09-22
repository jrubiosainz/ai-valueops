import { readJson } from '../src/files.mjs';
import { prepareRequest, checkAnswer } from '../src/qa-service.mjs';
import { fixtureResponse } from '../src/fixtures.mjs';
import { makeEvidence } from '../src/evidence.mjs';

export async function fixtureInputs({ mode = 'live-azure' } = {}) {
  const [config, corpus, gold, sourcePricing] = await Promise.all([
    readJson('config/experiment.json'), readJson('samples/corpus.json'),
    readJson('samples/gold.json'), readJson('samples/pricing.json'),
  ]);
  const pricing = { ...sourcePricing, retrievedAt: new Date().toISOString() };
  const runId = 'unit-test-only-not-cloud-evidence';
  const execution = {
    mode, runId, deploymentName: config.deploymentName, accountRegion: 'westeurope',
    expectedRequests: 48, attemptedRequests: 48, inputsCommitted: true,
  };
  const observations = [];
  for (let repetition = 1; repetition <= config.repetitions; repetition++) {
    for (const item of gold.cases) {
      for (const variant of ['full', 'selected', 'aggressive']) {
        const request = prepareRequest(corpus, item.question, variant, config, { syntheticExperiment: true });
        const response = fixtureResponse(request, item, variant, repetition);
        observations.push({
          variant, caseId: item.id, repetition, sourceIds: request.sourceIds,
          policy: request.policy, ...response,
          model: mode === 'live-azure' ? `${config.model}-${config.modelVersion}` : 'synthetic-fixture',
          quality: checkAnswer(response.answer, item, request.sourceIds),
          attribution: { serviceId: config.serviceId, runId, caseId: item.id, variant,
            deploymentName: config.deploymentName, correlationId: response.responseId },
        });
      }
    }
  }
  return {
    runId, sourceCommit: 'a'.repeat(40),
    hashes: Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`test-source-${index}`, 'b'.repeat(64)])),
    config, corpus, gold, pricing, execution, observations,
  };
}

export async function fixtureEvidence(options) {
  return makeEvidence(await fixtureInputs(options));
}

import { readJson } from './files.mjs';

const positive = (value) => Number.isSafeInteger(value) && value > 0;

export function validateInputs({ config, corpus, gold, service }) {
  if (config?.schemaVersion !== 1 || corpus?.classification !== 'synthetic' || gold?.classification !== 'synthetic' ||
      gold.version !== corpus.version || gold.version !== config.datasetVersion) {
    throw new Error('A matching versioned synthetic corpus, case set and experiment contract are required.');
  }
  for (const key of ['repetitions', 'maxRequests', 'maxTotalTokens', 'maxWallTimeMs', 'requestTimeoutMs',
    'maxOutputTokens', 'maxPromptCharacters', 'selectedDocumentCount']) {
    if (!positive(config[key])) throw new Error(`Invalid positive integer in experiment contract: ${key}.`);
  }
  if (!Number.isSafeInteger(config.requestIntervalMs) || config.requestIntervalMs < 0 ||
      config.requestTimeoutMs > config.maxWallTimeMs) throw new Error('Invalid request timing contract.');
  for (const key of ['serviceId', 'model', 'modelVersion', 'modelSku', 'apiVersion', 'deploymentName']) {
    if (typeof config[key] !== 'string' || !config[key].trim()) throw new Error(`Missing experiment field: ${key}.`);
  }
  const thresholds = config.thresholds;
  if (!thresholds || !Number.isFinite(thresholds.minimumQualityRate) ||
      thresholds.minimumQualityRate <= 0 || thresholds.minimumQualityRate > 1 ||
      thresholds.minimumPolicyRate !== 1 || thresholds.minimumAttributionCoverage !== 1 ||
      !positive(thresholds.maximumP95LatencyMs) || !positive(thresholds.maximumPriceAgeDays) ||
      !Number.isFinite(thresholds.minimumEstimatedCostReductionPct) ||
      thresholds.minimumEstimatedCostReductionPct <= 0 || thresholds.minimumEstimatedCostReductionPct >= 100) {
    throw new Error('Invalid thresholds. Complete mandatory policy and attribution cannot be waived.');
  }
  if (!Array.isArray(corpus.documents) || !corpus.documents.length ||
      corpus.documents.some((doc) => typeof doc.id !== 'string' || !doc.id ||
        typeof doc.title !== 'string' || typeof doc.text !== 'string' ||
        !Array.isArray(doc.tags) || doc.tags.some((tag) => typeof tag !== 'string')) ||
      new Set(corpus.documents.map((doc) => doc.id)).size !== corpus.documents.length) {
    throw new Error('Corpus documents must have unique IDs and valid text, titles and tags.');
  }
  if (!Array.isArray(config.mandatoryDocumentIds) || !config.mandatoryDocumentIds.length ||
      new Set(config.mandatoryDocumentIds).size !== config.mandatoryDocumentIds.length ||
      config.mandatoryDocumentIds.some((id) => !corpus.documents.some((doc) => doc.id === id)) ||
      config.selectedDocumentCount > corpus.documents.length - config.mandatoryDocumentIds.length) {
    throw new Error('Invalid mandatory policy IDs or selected-context size.');
  }
  if (!Array.isArray(gold.cases) || !gold.cases.length ||
      new Set(gold.cases.map((item) => item.id)).size !== gold.cases.length ||
      gold.cases.some((item) => typeof item.id !== 'string' || !item.id ||
        typeof item.question !== 'string' || !item.question.trim() || item.question.length > 1500 ||
        !Array.isArray(item.statuses) || !item.statuses.length ||
        item.statuses.some((status) => !['answer', 'abstain', 'escalate', 'refuse'].includes(status)) ||
        !Array.isArray(item.facts) || item.facts.some((fact) => !fact.id || !Array.isArray(fact.anyOf) ||
          !fact.anyOf.length || fact.anyOf.some((phrase) => typeof phrase !== 'string' || !phrase)) ||
        !Array.isArray(item.citations) || item.citations.some((id) => !corpus.documents.some((doc) => doc.id === id)) ||
        !Array.isArray(item.forbiddenTerms) || item.forbiddenTerms.some((term) => typeof term !== 'string') ||
        typeof item.fixtureAnswer !== 'string' || !item.fixtureAnswer.trim()) ||
      gold.cases.length * config.repetitions * 3 > config.maxRequests) {
    throw new Error('Invalid case matrix or request budget.');
  }
  if (service?.serviceId !== config.serviceId || !['full', 'selected'].includes(service.strategy)) {
    throw new Error('Active service must use a policy-preserving strategy for the configured service.');
  }
  return { config, corpus, gold, service };
}

export async function loadInputs() {
  const [config, corpus, gold, service, pricing] = await Promise.all([
    readJson('config/experiment.json'), readJson('samples/corpus.json'),
    readJson('samples/gold.json'), readJson('config/service.json'), readJson('config/pricing.json'),
  ]);
  return { ...validateInputs({ config, corpus, gold, service }), pricing };
}

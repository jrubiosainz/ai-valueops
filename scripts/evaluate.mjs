import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { loadInputs } from '../src/config.mjs';
import { writeLocal, writeLocalJson, inputHashes, assertCommittedInputs, inputsCommitted, sourceCommit, sha256 } from '../src/files.mjs';
import { prepareRequest, checkAnswer } from '../src/qa-service.mjs';
import { callFoundry } from '../src/foundry.mjs';
import { fixtureResponse } from '../src/fixtures.mjs';
import { makeEvidence, pricingChecks } from '../src/evidence.mjs';
import { accessToken, validateDeployment, deploymentConfig, reportFailure, sanitize } from './azure.mjs';

export function assertBudget({ attemptedRequests, observedTokens, started, nextReservation, config, now = Date.now() }) {
  if (![attemptedRequests, observedTokens, nextReservation].every((value) => Number.isSafeInteger(value) && value >= 0) ||
      !Number.isFinite(started) || !Number.isFinite(now) || now < started) throw new Error('Invalid budget accounting; no dispatch.');
  if (attemptedRequests >= config.maxRequests) throw new Error('Hard request budget reached; no dispatch.');
  if (observedTokens + nextReservation > config.maxTotalTokens) throw new Error('Next-request token reservation exceeds the remaining token reservation budget.');
  if (now - started + config.requestTimeoutMs > config.maxWallTimeMs) throw new Error('Run wall-clock budget reached; no dispatch.');
}

export function servicePatch(service) {
  if (service.strategy !== 'full') throw new Error('A proposal requires the full-context active baseline.');
  const before = JSON.stringify(service, null, 2).split('\n');
  const after = JSON.stringify({ ...service, strategy: 'selected' }, null, 2).split('\n');
  return [
    'diff --git a/config/service.json b/config/service.json',
    '--- a/config/service.json', '+++ b/config/service.json',
    `@@ -1,${before.length} +1,${after.length} @@`,
    ...before.map((line) => `-${line}`), ...after.map((line) => `+${line}`), '',
  ].join('\n');
}

export async function evaluate({ fixture = false } = {}) {
  if (!fixture && process.env.AI_VALUEOPS_ALLOW_INFERENCE !== 'true') {
    throw new Error('Live evaluation is billable. Set AI_VALUEOPS_ALLOW_INFERENCE=true and explicitly choose --live; the demo makes no model calls.');
  }
  const { config, corpus, gold, service, pricing } = await loadInputs();
  if (service.strategy !== 'full') throw new Error('This experiment proposes a change from the full-context active baseline only.');
  const hashes = await inputHashes();
  const commit = sourceCommit({ required: !fixture });
  if (!fixture) assertCommittedInputs(Object.keys(hashes));
  const runId = `${fixture ? 'fixture' : 'azure'}-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  let deployment = {
    deploymentName: config.deploymentName, accountRegion: pricing.accountRegion,
    processingScope: 'Offline synthetic fixture; no Azure calls.',
  };
  let token = null;
  if (!fixture) {
    deployment = deploymentConfig();
    if (!pricingChecks(pricing, config, deployment).every((entry) => entry.passed)) {
      throw new Error('Price snapshot is stale or mismatched. Refresh and commit it before a live evaluation.');
    }
    deployment = validateDeployment(config);
    token = accessToken();
  }
  const execution = {
    mode: fixture ? 'local-fixture' : 'live-azure', runId,
    serviceId: config.serviceId, model: config.model, modelVersion: config.modelVersion,
    inputsCommitted: inputsCommitted(Object.keys(hashes)),
    deploymentName: deployment.deploymentName, accountRegion: deployment.accountRegion, modelSku: config.modelSku,
    processingScope: deployment.processingScope,
    repetitions: config.repetitions, expectedRequests: gold.cases.length * config.repetitions * 3,
    maxRequests: config.maxRequests, maxTotalTokens: config.maxTotalTokens, maxWallTimeMs: config.maxWallTimeMs,
    requestIntervalMs: fixture ? 0 : config.requestIntervalMs,
    attemptedRequests: 0, startedAt: new Date().toISOString(),
  };
  const observations = [];
  const started = Date.now();
  let lastDispatch = 0;
  let observedTokens = 0;
  let failure = null;
  try {
    for (let repetition = 1; repetition <= config.repetitions; repetition++) {
      for (const item of gold.cases) {
        // Rotate order without disabling provider caching.
        const variants = repetition % 2 ? ['full', 'selected', 'aggressive'] : ['aggressive', 'selected', 'full'];
        for (const variant of variants) {
          const request = prepareRequest(corpus, item.question, variant, config, { syntheticExperiment: true });
          if (!fixture) await delay(Math.max(0, config.requestIntervalMs - (Date.now() - lastDispatch)));
          const reservation = Buffer.byteLength(JSON.stringify(request.messages), 'utf8') +
            Buffer.byteLength(JSON.stringify(request.responseSchema), 'utf8') + config.maxOutputTokens + 256;
          assertBudget({ attemptedRequests: execution.attemptedRequests, observedTokens, started, nextReservation: reservation, config });
          const correlationId = randomUUID();
          execution.attemptedRequests++;
          lastDispatch = Date.now();
          const response = fixture ? fixtureResponse(request, item, variant, repetition) :
            await callFoundry({ deployment, token, request, config, correlationId });
          const quality = checkAnswer(response.answer, item, request.sourceIds, response.finishReason);
          observations.push({
            variant, caseId: item.id, repetition, sourceIds: request.sourceIds,
            promptSha256: request.promptSha256, promptCharacters: request.promptCharacters,
            responseSchemaSha256: request.responseSchemaSha256, dispatchDisposition: request.disposition,
            policy: request.policy, quality,
            attribution: { serviceId: config.serviceId, runId, caseId: item.id, variant,
              deploymentName: deployment.deploymentName, correlationId },
            ...response,
          });
          console.log(`${fixture ? 'SYNTHETIC' : 'MEASURED'} ${execution.attemptedRequests}/${execution.expectedRequests} ${variant}/${item.id}/${repetition} quality=${quality.passed} policy=${request.policy.passed}`);
          if (!response.usage.complete) throw new Error('Incomplete token telemetry; remaining calls stopped.');
          observedTokens += response.usage.totalTokens;
          if (observedTokens > config.maxTotalTokens) throw new Error('Observed tokens exceeded the hard run budget; remaining calls stopped.');
        }
      }
    }
    if (JSON.stringify(await inputHashes()) !== JSON.stringify(hashes) || sourceCommit() !== commit ||
        (!fixture && !inputsCommitted(Object.keys(hashes)))) {
      throw new Error('Evaluator inputs or source commit changed during the run; approval is blocked.');
    }
  } catch (error) {
    failure = sanitize(error.message);
    console.error(`RUN BLOCKED: ${failure}`);
  }
  execution.completedAt = new Date().toISOString();
  execution.observedTokens = observedTokens;
  const evidence = makeEvidence({ runId, sourceCommit: commit, hashes, config, gold, pricing, execution, observations, failure });
  if (evidence.proposal.eligible) {
    const patch = servicePatch(service);
    evidence.proposal.sha256 = sha256(patch);
    await writeLocal(`.local/proposals/${runId}.patch`, patch);
    evidence.artifacts.push({ label: 'Proposed change, not applied or approved', path: 'proposal.patch' });
  }
  const path = `.local/runs/${runId}.json`;
  await writeLocalJson(path, evidence);
  console.log(JSON.stringify({ runId, mode: execution.mode, approval: evidence.approval, comparison: evidence.comparison, report: path }, null, 2));
  return evidence;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !['--fixture', '--live'].includes(args[0])) {
    reportFailure(new Error('Choose exactly --fixture (offline synthetic checks) or --live (explicitly authorized billable evaluation).'));
  } else {
    evaluate({ fixture: args[0] === '--fixture' }).then((report) => {
      if (report.failure || report.checks.some((entry) => !entry.passed)) process.exitCode = 1;
    }).catch(reportFailure);
  }
}

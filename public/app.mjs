import { number, money, rate, duration, date, reduction, latencyChange } from './format.mjs';

const get = (id) => document.getElementById(id);
const text = (id, value) => { get(id).textContent = value; };
const element = (tag, value, className) => {
  const node = document.createElement(tag);
  if (value !== undefined) node.textContent = value;
  if (className) node.className = className;
  return node;
};
const chip = (value, kind) => element('span', value, `chip ${kind}`);
const labels = { full: 'Full context', selected: 'Selected + policy', aggressive: 'Policy removed' };
const subtitles = { full: 'Baseline', selected: 'Optimization candidate', aggressive: 'Negative control' };

async function fetchJson(path) {
  const response = await fetch(new URL(path, import.meta.url), { cache: 'no-store', redirect: 'error' });
  if (!response.ok) throw new Error(`Could not load ${path} (HTTP ${response.status}).`);
  return response.json();
}

function showPanel({ focus = false } = {}) {
  const requested = location.hash.slice(1) || 'overview';
  const known = ['overview', 'policy', 'answers', 'method'];
  const current = known.includes(requested) ? requested : 'overview';
  for (const panel of document.querySelectorAll('[data-panel]')) panel.hidden = panel.dataset.panel !== current;
  for (const link of document.querySelectorAll('[data-nav]')) {
    if (link.dataset.nav === current) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  if (focus) get(current).focus({ preventScroll: true });
  document.title = `AI ValueOps | ${get(`${current}-title`).textContent}`;
}

function renderComparison(report, manifest) {
  const baseline = report.baseline;
  const selected = report.candidates[0];
  const aggressive = report.candidates[1];
  const recorded = report.executionMode === 'recorded-azure';
  const fixture = report.executionMode === 'local-fixture';
  text('mode-label', recorded ? 'Recorded Azure responses' : fixture ? 'Synthetic offline fixture' : 'Saved Azure evaluation');
  text('recording-detail', `${date(report.generatedAt)} / Synthetic English cases / No inference from this viewer`);
  text('token-reduction', reduction(report.comparison.inputTokenReductionPct));
  text('token-comparison', `${number(baseline.usage.inputTokens)} to ${number(selected.usage.inputTokens)} input tokens`);
  text('cost-reduction', reduction(report.comparison.estimatedCostReductionPct));
  text('cost-comparison', `${money(baseline.estimatedCostUsd)} to ${money(selected.estimatedCostUsd)}`);
  text('quality-result', rate(selected.quality));
  text('quality-comparison', `${rate(selected.quality)} quality / ${rate(selected.policy)} policy`);
  text('median-result', duration(selected.latency.p50Ms));
  text('median-comparison', `${duration(baseline.latency.p50Ms)} to ${duration(selected.latency.p50Ms)}`);
  text('median-note', latencyChange(baseline.latency.p50Ms, selected.latency.p50Ms));
  text('matrix-size', `${number(report.observations.length)} responses / 3 strategies`);
  const tokenNote = document.querySelector('.metric small');
  tokenNote.textContent = fixture ? 'Synthetic fixture values, not measurements' : 'Measured response usage, not a token estimate';
  for (const summary of [baseline, selected, aggressive]) {
    const tr = element('tr', undefined, summary.id === 'selected' ? 'selected-row' : '');
    const name = element('td');
    name.append(element('strong', labels[summary.id]), element('small', subtitles[summary.id]));
    tr.append(name, element('td', number(summary.usage.inputTokens)), element('td', money(summary.estimatedCostUsd)));
    for (const result of [summary.quality, summary.policy]) tr.append(element('td', rate(result), result.rate === 1 ? '' : 'cell-fail'));
    tr.append(element('td', `${number(summary.latency.p50Ms)} / ${number(summary.latency.p95Ms)} ms`));
    const decision = element('td');
    decision.append(chip(summary.accepted ? 'Passes gates' : 'Blocked', summary.accepted ? 'pass' : 'fail'));
    tr.append(decision);
    get('comparison-rows').append(tr);
  }
  text('cache-note', `Baseline includes ${number(baseline.usage.cachedInputTokens)} cached input tokens; selected context includes ${number(selected.usage.cachedInputTokens)}. Cache discounts explain why estimated cost and input-token reductions differ. Prices and gates describe the report date, not current authorization.`);
  const proposed = recorded ? report.proposal.recordedEligible : report.proposal.eligible;
  text('outcome-title', fixture ? 'Synthetic fixture only. No optimization proposal.' :
    proposed ? 'Candidate passes the experiment. Human review is still required.' : 'Candidate blocked. No optimization proposal.');
  text('outcome-detail', recorded ? 'This recorded example cannot authorize a change. Active configuration remains unchanged.' :
    'This viewer cannot approve, merge, deploy or apply a configuration change.');
  text('negative-policy', rate(aggressive.policy));
  text('negative-quality', rate(aggressive.quality));
  text('negative-cost', money(aggressive.estimatedCostUsd));
  const gateNames = {
    'complete-case-matrix': 'Complete case / repetition matrix',
    'attribution-coverage': 'Response and usage attribution',
    quality: 'Required facts, disposition and citations',
    'mandatory-policy': 'Mandatory POLICY-001 in context',
    'response-disposition-contract': 'Pre-dispatch disposition contract',
    'latency-slo': 'Absolute p95 latency limit',
  };
  for (const check of aggressive.checks) {
    const row = element('li');
    row.append(element('span', gateNames[check.id] || check.id), chip(check.passed ? 'Pass' : 'Fail', check.passed ? 'pass' : 'fail'));
    get('negative-checks').append(row);
  }
  text('human-summary', recorded ? 'The recorded candidate met the experiment gates. It was a proposal for review, not a human approval. A new evaluation is needed before considering a change.' :
    fixture ? 'Fixture outcomes exercise the control flow with generated data. They cannot justify a live change.' :
      report.proposal.eligible ? 'The saved evaluation produced a proposed diff. A person must independently review it before any operator makes a change.' :
        'At least one gate failed. This evaluation produced no eligible optimization proposal.');
  text('active-strategy', manifest.activeService.strategy);
}

function renderCases(report, gold) {
  for (const item of gold.cases) {
    const option = element('option', item.id.replaceAll('-', ' '));
    option.value = item.id;
    get('case-select').append(option);
  }
  if (gold.cases.some((item) => item.id === 'mfa-recovery')) get('case-select').value = 'mfa-recovery';
  for (let value = 1; value <= report.execution.repetitions; value++) {
    const option = element('option', `${value} of ${report.execution.repetitions}`);
    option.value = String(value);
    get('repetition-select').append(option);
  }
  const render = () => {
    const item = gold.cases.find((entry) => entry.id === get('case-select').value);
    const repetition = Number(get('repetition-select').value);
    text('case-question', item.question);
    get('answer-cards').replaceChildren();
    for (const variant of ['full', 'selected', 'aggressive']) {
      const row = report.observations.find((entry) => entry.variant === variant && entry.caseId === item.id && entry.repetition === repetition);
      const card = element('article', undefined, 'card answer-card');
      card.append(element('p', subtitles[variant].toUpperCase(), 'eyebrow'), element('h2', labels[variant]));
      if (!row) {
        card.append(element('p', 'No response was recorded for this case and repetition. The case matrix is incomplete.'));
        get('answer-cards').append(card);
        continue;
      }
      const chips = element('div', undefined, 'chips');
      chips.append(chip(row.answer?.status || 'Unparsed response', 'neutral'),
        chip(row.quality.passed ? 'Quality pass' : 'Quality fail', row.quality.passed ? 'pass' : 'fail'),
        chip(row.policy.passed ? 'Policy present' : 'Policy missing', row.policy.passed ? 'pass' : 'fail'));
      card.append(chips, element('blockquote', row.answer?.answer || 'No parsed answer was accepted.'));
      card.append(element('p', `Citations: ${row.answer?.citations?.join(', ') || 'None'}`, 'source-list'));
      const facts = element('dl', undefined, 'gate-facts');
      for (const [name, value] of [['Input / cached tokens', `${number(row.usage.inputTokens)} / ${number(row.usage.cachedInputTokens)}`],
        ['Output tokens', number(row.usage.outputTokens)], ['Client latency', duration(row.latencyMs)]]) {
        const pair = element('div');
        pair.append(element('dt', name), element('dd', value));
        facts.append(pair);
      }
      const notes = element('ul', undefined, 'answer-notes');
      for (const detail of row.quality.details) notes.append(element('li', detail));
      card.append(facts, notes, element('p', `Context: ${row.sourceIds.join(', ')}`, 'source-list'));
      get('answer-cards').append(card);
    }
  };
  get('case-select').addEventListener('change', render);
  get('repetition-select').addEventListener('change', render);
  render();
}

function renderMethod(report, manifest) {
  text('model-name', `${report.execution.model} / ${report.execution.modelVersion}`);
  text('dataset-version', report.inputs.datasetVersion);
  text('price-date', `${date(report.pricing.retrievedAt)} / USD list prices`);
  for (const value of report.limitations) get('limitations').append(element('li', value));
  for (const artifact of report.artifacts) {
    if (!/^(?:samples\/(?:corpus|gold|pricing|recorded)\.json|config\/(?:experiment|service)\.json|evidence\.json|proposal\.patch)$/.test(artifact.path)) {
      throw new Error('The report contains an unsupported artifact path.');
    }
    const link = element('a', artifact.label);
    link.href = artifact.path;
    const li = element('li');
    li.append(link);
    get('artifact-links').append(li);
  }
  text('report-hash', manifest.reportSha256);
  text('viewer-commit', manifest.uiSourceCommit ?
    `${manifest.uiSourceCommit}${manifest.uiInputsCommitted ? '' : ' (working files are not all committed)'}` :
    'Unavailable in this Gitless copy; the offline viewer still works.');
  text('executed-commit', report.sourceCommit || (report.executionMode === 'recorded-azure' ?
    'Not a run of this checkout. See recorded provenance below.' : 'Unavailable in this Gitless fixture.'));
  if (report.executionMode === 'recorded-azure') {
    text('original-hash', report.provenance.originalReportSha256);
    text('provenance-note', 'Curated recorded example: metadata and path adaptation only. The answers, per-call measurements and aggregate values are unchanged. The curated file has its own hash; no new inference or independent execution attestation is claimed.');
  } else {
    get('original-hash-row').hidden = true;
    text('provenance-note', report.executionMode === 'local-fixture' ?
      'Synthetic fixture output. Input hashes identify the working files; this is not measured Azure evidence.' :
      'An authenticated operator saved this evaluation. Source hashes bind its inputs; they are not a service signature or independent execution attestation.');
  }
}

try {
  const [report, manifest, gold] = await Promise.all([fetchJson('evidence.json'), fetchJson('manifest.json'), fetchJson('samples/gold.json')]);
  if (report.productId !== 'ai-valueops' || report.schemaVersion !== 1 || manifest.readOnly !== true ||
      report.classification !== 'synthetic' || report.approval.promotionAllowed !== false ||
      !['recorded-azure', 'local-fixture', 'live-azure'].includes(report.executionMode) ||
      !['pending', 'rejected', 'not-required'].includes(report.approval.state)) {
    throw new Error('Unsupported report or approval contract. No successful outcome can be inferred.');
  }
  renderComparison(report, manifest);
  renderCases(report, gold);
  renderMethod(report, manifest);
  showPanel();
  window.addEventListener('hashchange', () => showPanel({ focus: true }));
  get('loading').hidden = true;
  get('workspace').hidden = false;
  document.body.dataset.ready = 'true';
} catch (error) {
  get('loading').hidden = true;
  get('workspace').hidden = true;
  text('load-error', `Report unavailable: ${error.message} Run npm run build, then serve the built viewer. No data or successful result has been substituted.`);
  get('load-error').hidden = false;
}

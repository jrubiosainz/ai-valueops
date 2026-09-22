export function fixtureResponse(request, gold, variant, repetition) {
  const inputTokens = Math.ceil(request.promptCharacters / 4);
  const outputTokens = Math.ceil(gold.fixtureAnswer.length / 4);
  return {
    answer: {
      status: gold.statuses[0], answer: gold.fixtureAnswer,
      citations: gold.citations.filter((id) => request.sourceIds.includes(id)),
    },
    parseError: null, rawAnswer: null, finishReason: 'stop',
    usage: { inputTokens, outputTokens, cachedInputTokens: 0, totalTokens: inputTokens + outputTokens, complete: true },
    latencyMs: 900 + inputTokens / 10 + repetition,
    model: 'synthetic-fixture', responseId: `fixture-${variant}-${gold.id}-${repetition}`,
    requestId: null, systemFingerprint: null,
    responseContract: {
      passed: request.disposition.allowedStatuses.includes(gold.statuses[0]),
      allowedStatuses: request.disposition.allowedStatuses,
      humanRequired: request.disposition.humanRequired,
      method: 'Synthetic fixture contract check, not an Azure response.',
    },
  };
}

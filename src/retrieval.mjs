const STOP_WORDS = new Set(
  'a an the is are was were be been to of for in on at and or as it i me my we our you your can could may what when who how do does did if has have had with from that this then so by into its not only'.split(' '),
);

export function words(text) {
  return text.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .match(/[a-z0-9]+/g)?.filter((word) => !STOP_WORDS.has(word)) ?? [];
}

export function selectContext(corpus, question, strategy, config) {
  if (!['full', 'selected', 'aggressive'].includes(strategy)) throw new Error(`Unknown strategy: ${strategy}`);
  const documents = corpus.documents;
  const ids = new Set(documents.map((doc) => doc.id));
  if (ids.size !== documents.length || config.mandatoryDocumentIds.some((id) => !ids.has(id))) {
    throw new Error('Corpus contains duplicate IDs or is missing mandatory policy.');
  }
  if (strategy === 'full') return documents;
  const query = new Set(words(question));
  const searchable = documents.filter((doc) => !config.mandatoryDocumentIds.includes(doc.id));
  const indexed = searchable.map((doc) => ({
    doc,
    body: words(doc.text),
    tags: new Set(words(`${doc.title} ${doc.tags.join(' ')}`)),
  }));
  const ranked = indexed.map(({ doc, body, tags }) => {
    let score = 0;
    for (const term of query) {
      const documentFrequency = indexed.filter((item) => item.tags.has(term) || item.body.includes(term)).length;
      const weight = Math.log(1 + indexed.length / (1 + documentFrequency));
      const count = body.filter((word) => word === term).length;
      score += weight * (Math.min(count, 3) + (tags.has(term) ? 4 : 0));
    }
    return { doc, score };
  }).sort((a, b) => b.score - a.score || a.doc.id.localeCompare(b.doc.id));
  const take = strategy === 'aggressive' ? 1 : config.selectedDocumentCount;
  const selected = ranked.slice(0, take).map(({ doc }) => doc);
  if (strategy === 'aggressive') return selected;
  return [...documents.filter((doc) => config.mandatoryDocumentIds.includes(doc.id)), ...selected];
}

export function checkContextPolicy(documents, config) {
  const missing = config.mandatoryDocumentIds.filter((id) => !documents.some((doc) => doc.id === id));
  return {
    passed: missing.length === 0,
    details: missing.length ? `Missing mandatory context: ${missing.join(', ')}. Production dispatch is blocked.` :
      'Every mandatory policy document is included in the request context.',
  };
}

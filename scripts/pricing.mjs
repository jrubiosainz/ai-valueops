import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { readJson, withinRoot } from '../src/files.mjs';
import { reportFailure } from './azure.mjs';

const meters = {
  input: 'gpt 4.1 mini Inp glbl Tokens',
  cachedInput: 'gpt 4.1 mini cached Inp glbl Tokens',
  output: 'gpt 4.1 mini Outp glbl Tokens',
};

export function selectPrices(data, region, now = Date.now()) {
  if (!Array.isArray(data.Items) || data.NextPageLink) throw new Error('Price result is missing or paginated; refusing a partial snapshot.');
  const records = {};
  for (const [kind, name] of Object.entries(meters)) {
    const matches = data.Items.filter((item) => item.meterName === name && item.type === 'Consumption' &&
      item.productName === 'Azure OpenAI' && item.currencyCode === 'USD' && item.armRegionName === region &&
      item.unitOfMeasure === '1K' && Date.parse(item.effectiveStartDate) <= now);
    matches.sort((a, b) => Date.parse(b.effectiveStartDate) - Date.parse(a.effectiveStartDate));
    if (!matches.length || (matches[1] && matches[0].effectiveStartDate === matches[1].effectiveStartDate)) {
      throw new Error(`No unambiguous current retail price for ${kind}.`);
    }
    const item = matches[0];
    if (!Number.isFinite(item.retailPrice) || item.retailPrice <= 0 || item.retailPrice > 1) {
      throw new Error(`Unexpected ${kind} price or unit; operator review required.`);
    }
    records[kind] = Object.fromEntries(['meterName', 'meterId', 'skuName', 'productName', 'armRegionName',
      'retailPrice', 'unitOfMeasure', 'currencyCode', 'effectiveStartDate'].map((key) => [key, item[key]]));
  }
  return records;
}

export async function capturePrices(region, fetchImpl = fetch) {
  if (!/^[a-z0-9]+$/.test(region ?? '')) throw new Error('Usage: npm run pricing -- --region <account-region>');
  const config = await readJson('config/experiment.json');
  if (config.model !== 'gpt-4.1-mini' || config.modelVersion !== '2025-04-14' || config.modelSku !== 'GlobalStandard') {
    throw new Error('This price adapter supports only the pinned model/version and GlobalStandard SKU; do not infer rates for another model.');
  }
  const sourceUrl = 'https://prices.azure.com/api/retail/prices';
  const query = `armRegionName eq '${region}' and productName eq 'Azure OpenAI' and (${Object.values(meters).map((name) => `meterName eq '${name}'`).join(' or ')})`;
  const url = new URL(sourceUrl);
  url.searchParams.set('$filter', query);
  url.searchParams.set('currencyCode', "'USD'");
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(30000), redirect: 'error' });
  if (!response.ok) throw new Error(`Official price request failed: HTTP ${response.status}.`);
  const records = selectPrices(await response.json(), region);
  return {
    schemaVersion: 1, kind: 'estimated', currency: 'USD', model: config.model, modelVersion: config.modelVersion,
    sku: config.modelSku, accountRegion: region, sourceUrl, sourceQuery: query, retrievedAt: new Date().toISOString(),
    ratesPerMillion: Object.fromEntries(Object.entries(records).map(([key, row]) => [key, row.retailPrice * 1000])),
    records,
    method: '(uncached input tokens * input rate + cached input tokens * cached rate + output tokens * output rate) / 1,000,000.',
    exclusions: 'List-price estimate only. No invoices, negotiated discounts, taxes, credits, storage, network or other resource charges.',
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--region') {
    reportFailure(new Error('Usage: npm run pricing -- --region <account-region>. This fetches public prices, not model responses.'));
  } else {
    capturePrices(args[1]).then(async (snapshot) => {
      await writeFile(withinRoot('config/pricing.json'), `${JSON.stringify(snapshot, null, 2)}\n`);
      console.log('Updated config/pricing.json. Review and commit the snapshot before a live evaluation.');
    }).catch(reportFailure);
  }
}

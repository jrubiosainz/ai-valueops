# Azure operator guide

The local demo, build, tests and MCP tools do not use Azure. These steps are for a deliberate, potentially billable evaluation of the synthetic workload in your own authorized account. Do not use customer content.

## Use an existing deployment

1. Install Azure CLI and sign in to your authorized tenant. Ensure the operator has **Cognitive Services OpenAI User** access on the intended account. This product does not grant roles.
2. Copy `.env.example` to `.env` and replace the placeholders. Choose your subscription, tenant, resource group, account, endpoint, deployment and account region. The account must disable local-key authentication. The scripts pass the subscription explicitly; they never change the global CLI account.
3. Check the pinned model's availability and retirement status in your region. The included contract uses `gpt-4.1-mini`, version `2025-04-14`, with `GlobalStandard`. That model was reported as Legacy in the recorded setup; do not assume it remains deployable. The price adapter refuses other models/SKUs rather than inventing a price. A different model requires an explicit adapter and acceptance-contract change.
4. Review `config/experiment.json`. The deployment name must match the environment value. Confirm the budgets, policy IDs and thresholds before the run.

Refresh prices for your account region, for example:

```sh
npm run pricing -- --region westeurope
```

This queries only the public Azure retail-price API and updates `config/pricing.json`. It does not authenticate or invoke a model. Missing, ambiguous, stale or model/region-mismatched prices block live evaluation. The recorded sample keeps its own unchanged price snapshot in `samples/pricing.json`.

Review and commit the relevant configuration and evaluator files in your checkout before evaluating. New reports bind the **actual current commit and input hashes**; untracked, staged or modified inputs are rejected.

## Evaluate

Set `AI_VALUEOPS_ALLOW_INFERENCE=true` in your local `.env` only after reviewing the scope and budget. With Node 20.6+:

```sh
node --env-file=.env scripts/evaluate.mjs --live
```

On a Node version without `--env-file`, export the variables with your preferred trusted environment manager and use `npm run evaluate -- --live`.

The default experiment makes at most 48 requests, with 15-second pacing and no automatic retries. It rotates strategy order, leaves provider caching enabled, and enforces request, conservative token-reservation and wall-clock budgets before dispatch. Keyless account state, model/version/SKU, capacity, endpoint and region are checked before inference. Account-local keys are neither accepted nor stored.

The negative strategy intentionally omits mandatory policy **only for this synthetic experiment**. Normal request preparation refuses it before any model call. Incomplete telemetry, input drift, a failed gate or a transport error blocks the proposal and produces a nonzero exit status. If dispatch has started, the partial report is retained with its failure; preflight failures produce no successful report.

Reports are written under `.local/runs/`. Only an eligible live report also produces a patch under `.local/proposals/`. Nothing changes `config/service.json`. A human must review the evidence, limitations, current price assumptions and diff; any approval and application are separate actions.

To view a saved report, substitute its actual filename:

```sh
npm run build -- --report .local/runs/your-run-id.json
npm start
```

The evaluator inputs must still match the report's hashes. Inspect a report before sharing it. Locally generated reports are ignored by Git; they may contain your deployment name and provider response identifiers. Do not publish credentials, resource inventories or customer data.

## Optional infrastructure

`infra/main.bicep` provisions only a keyless OpenAI account and a pinned model deployment in an **existing** resource group. It creates no role assignments, storage accounts, web hosts or application changes. Network access is public but requires Entra authentication; this small synthetic setup is not a production network architecture.

Set `AZURE_RESOURCE_SUFFIX` to a unique 4-12 character lowercase alphanumeric value and `AZURE_MODEL_CAPACITY` to 1-10. Keep `AZURE_RESOURCE_GROUP` generic or use your own existing group. Availability, quota and regional pricing are your responsibility.

Plan without provisioning:

```sh
node --env-file=.env scripts/deploy.mjs --what-if
```

Only after reviewing the plan, set `AI_VALUEOPS_ALLOW_PROVISIONING=true` in `.env` and explicitly apply:

```sh
node --env-file=.env scripts/deploy.mjs --apply
```

Set the account name and endpoint from your resulting Azure resource, arrange the required operator access separately, and follow the evaluation steps above. Provisioning does not run inference. No script deletes resources or silently substitutes a model.

# Architecture

AI ValueOps separates evaluation from viewing and authorization. The implementation uses Node's standard library and a static UI; there is no database or application dependency to operate.

## Data and evaluation

`samples/corpus.json` contains the fictional LumenDesk handbook. `samples/gold.json` defines eight English acceptance cases. The full strategy includes every document; selected context includes mandatory policy plus the highest-ranked non-policy document. The aggressive strategy is a negative control that omits mandatory policy.

`src/qa-service.mjs` builds the shared prompt and constrains identity-recovery dispositions before dispatch. It evaluates required facts, allowed statuses, citations, truncation and injected markers without rewriting model answers. This bounded English rule and exact-fact method do not establish general semantic correctness.

`scripts/evaluate.mjs` validates the contract, binds input hashes and the current source commit, and enforces budgets. Live operation authenticates through Azure CLI and checks deployment state. Offline fixtures use generated answers and telemetry, never model calls.

`src/evidence.mjs` requires complete, unique case/repetition pairs and response/correlation identifiers before summing usage or estimating costs. Missing attribution makes the cost unavailable; it is never imputed as zero. Pricing must match the model, version, SKU and region, have positive rates, and be within the declared freshness window. Cost calculations account for cached input tokens. Latency uses nearest-rank quantiles, with the median and p95 both visible.

A proposal requires an acceptable baseline, a candidate that meets every gate without reducing accepted-case quality, the declared estimated-cost reduction, and rejection of the negative control. The evaluator emits reports and proposed patches only. Human approval is not represented by a machine-authored success flag.

## Recorded example versus new output

The included report is a curated recording, not the output of the current checkout. Its provenance identifies the original report by SHA-256 and explicitly records a metadata/path-only adaptation. All 48 answers, source IDs, per-call measurements, summary values and prices are preserved. Tests reconstruct the prompts and response schemas and check their hashes against the recording.

The curated file has its own checksum. Its recorded gate results are evaluated at the recording date; they are not refreshed to today's prices. Builds validate the checksum and recompute the summary arithmetic and decisions. The recording has no eligible new patch and cannot authorize a change.

A new local fixture is marked synthetic, including its token, latency and monetary values. Fixture price arithmetic uses the bundled snapshot date, not a claim that those prices are current. A new live evaluation uses the actual Git commit and committed input hashes, and detects drift during the run.

## Viewer and MCP boundary

`scripts/build.mjs` emits only an explicit set of assets, synthetic data and the selected report into `dist/`. Live and fixture reports are opt-in build inputs; the default always uses the included recording. A Gitless copy works, with its viewer source commit explicitly unavailable rather than borrowed from an enclosing checkout.

`src/server.mjs` binds to loopback and permits only GET and HEAD on allowlisted paths. It rejects symlink escapes and serves a restrictive content security policy. The browser only fetches the built JSON and never sends an inference, approval or mutation request. Static hosts must preserve those boundaries.

`src/context-server.mjs` exposes three bounded, read-only MCP tools over stdio. The default source is the included checksum-verified recording. Unknown cases, arbitrary paths and command arguments are rejected; missing or invalid data produces an explicit tool error. Tool content is evidence to inspect, not instructions to execute.

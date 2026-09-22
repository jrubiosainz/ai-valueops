# Security

The default demo is local and read-only. It has no inference or approval endpoints, and accepts only the included synthetic workload. Live evaluation is an explicit authenticated operator action with budgets; provisioning has a separate opt-in. These controls are not a general production security or compliance certification.

Never put credentials, personal data, customer records or unredacted cloud diagnostics in a public issue. If GitHub private vulnerability reporting is available for this repository, use it. Otherwise, open an issue requesting a private contact **without including sensitive technical details**. No response-time commitment is implied.

Keep `.env` and `.local/` private. Review generated reports before sharing them, use narrowly scoped Azure permissions, and check model availability and retirement before live evaluation. A model's output, a passing experiment or an agent's recommendation is not human approval.

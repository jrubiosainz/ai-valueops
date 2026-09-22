# Contributing

Start with the offline experience in the README. Use Node.js 20+ and run:

```sh
npm ci
npm test
npm run build
```

Keep changes focused and add regression tests for behavior changes. In particular, preserve mandatory-policy checks, complete attribution, price freshness, explicit failures, the read-only viewer and the separate human-approval boundary. Tests must use included synthetic fixtures or local stubs, never a cloud account.

Do not replace the recorded example with generated measurements or alter its answers to make a check pass. Changes to that example must be clearly labeled and carry their own checksum and accurate provenance. A modified acceptance contract is not evidence that a model was rerun.

Use only code, data and assets you are authorized to share. Keep credentials, local environment files, real customer content and cloud diagnostics out of commits and issues. The repository has no selected reuse license.

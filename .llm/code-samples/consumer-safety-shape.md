<!-- summary: Minimal structural example for safe licensed consumer workflow review. -->
# Consumer Safety Shape

This is a review aid, not a copy-ready workflow. Exact action revisions must be
immutable reviewed commit SHAs.

```yaml
concurrency:
  group: licensed-${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: false

jobs:
  licensed:
    strategy:
      fail-fast: false
    steps:
      - name: Acquire immediately before licensed work
        id: acquire
        uses: Ambiguous-Interactive/ambiguous-organization-build-lock/.github/actions/acquire-build-lock@IMMUTABLE_COMMIT_SHA
      - name: Run licensed work
        if: steps.acquire.outputs.acquired == 'true'
        run: ./run-licensed-work
      - name: Release or clean queued identity
        if: always()
        uses: Ambiguous-Interactive/ambiguous-organization-build-lock/.github/actions/release-build-lock@IMMUTABLE_COMMIT_SHA
```

Real consumers also need hosted runner preflight, PR-head protection, scoped
App credentials, lifecycle evidence, fallback cleanup, and an always-reporting
required aggregate job. Read the consumer enrollment document and workflow
policy skill before implementation.

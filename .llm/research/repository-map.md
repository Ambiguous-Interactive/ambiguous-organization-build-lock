<!-- summary: Evidence-backed map of the repository stack, validation layers, and harness adoption constraints. -->
# Repository Map

Observed on 2026-07-26:

- Go 1.26 implements enrollment and workflow policy analysis.
- Node.js 24 implements public GitHub Actions and dependency-free contract tests.
- Actionlint is isolated in `tools/actionlint`.
- CI runs JavaScript syntax checks, actionlint, Node tests, Go tests, module
  verification/tidy checks, and the workflow credential audit.
- Several intentional legacy or bundled files exceed 300 lines, including the
  lock runtime and comprehensive policy tests.

Therefore the hard line limit governs the agentic knowledge surface and vendor
pointers, not unrelated production artifacts. This keeps agent context bounded
without forcing risky refactors that do not advance build-lock safety.

The reference harness in `wallstop/unity-helpers` informed the thin-pointer,
canonical-context, and generated-index design. This adaptation uses the explicit
300-line request, recursive discovery, modern Cursor and Gemini pointers, and
the repository's existing dependency-free Node toolchain.

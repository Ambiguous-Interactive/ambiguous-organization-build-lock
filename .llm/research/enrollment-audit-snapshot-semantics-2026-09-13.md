# Enrollment Audit Snapshot Semantics, 2026-09-13

<!-- summary: cmd/audit-unity-enrollment reads each consumer's pinned commit tree through git objects, never the working tree; commit a local consumer fix before the local analyzer can see it. -->

## Question

Why did a local consumer fix that was visible in the working tree keep
producing the old findings when re-running the unmodified analyzer?

## Answer

`cmd/audit-unity-enrollment` resolves each enrolled repository with
`loadExactSnapshot`: `git rev-parse HEAD`, an origin check, then
`enrollment.LoadGitSnapshot` on the pinned SHA. Snapshot files load through
git objects at that commit, not from disk. Working-tree edits, staged
edits, and even a different checked-out branch are invisible.

## Working method

1. Apply the consumer fix in the local clone.
2. Commit it on a local branch, so `HEAD`'s tree contains the fix.
3. Run `go run ./cmd/audit-unity-enrollment -repositories-root <root>`.
4. The local clone's origin URL must match the enrolled repository name.

Bisecting by copying file versions into the working tree proves nothing;
bisect by committing candidate states instead. Observed cost when unaware:
two wasted bisection rounds on session 096's unity-helpers static-matrix
RCA.

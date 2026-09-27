# Session 101: Steam deploy install acceptance audit

Date: 2026-09-27

## Objective and scope

Continue the repository goal and investigate the user-directed Steam issue,
[doughby-td #149](https://github.com/Ambiguous-Interactive/doughby-td/issues/149).
Preserve the organization Unity lock and licensed-resource safety. Do not change
organization policy or claim Steam client acceptance without an install and
launch.

The central repository has 12 open issues and no open pull requests. The
current priority inventory and dispositions are in
`progress/session-100-actionlint-module-refresh.md`. No central issue or
dependency work was superseded by this cross-repository Steam request.

## Current evidence

- Central `main` is clean at `541fbd1fc4a42f81483df8bc2b798edc5b2bf60a`.
  Build lock CI run `36285007994` and reaper delivery audit
  `36284716213` passed on the current merge commit. Run `36285284501`, the
  incident recovery audit, also passed on the current head.
- `doughby-td` issue #149 was closed as completed on 2026-09-27 after the
  Steam client install and launch succeeded.
- Deploy run `35802684251` passed on `main` and committed build ID `25471343`
  to application `5262930` branch `pre-release`, as recorded in the issue.
  Its build, replay, depot upload, and Unity seat lifecycle jobs passed.
- Later workflow run `36069632272` passed its player checks, but its Steam
  depot upload job was skipped. Run `36062617275` did not deploy because the
  player build rewrote the source tree.
- The latest `doughby-td` `main` CI run, `36283029142`, passed on
  2026-09-27. This does not prove Steam installation.
- This workspace has no Steam client process or executable. No machine-control
  or Unity bridge tool is available in this session.

## Client install and launch result

The owner installed the app and supplied its sanitized manifest state. It names
application `5262930`, build `25471343`, target build `25471343`, branch
`pre-release`, and installed depot `5262931`. Download and staging byte counts
match, and staging is complete. This proves the intended build reached a Steam
client.

The client first reported `An error occurred while launching the game: invalid
configuration`. The owner confirmed `Doughby.exe` existed in the installed
folder and found no Steamworks launch option. The owner added a Windows launch
option for `Doughby.exe` and confirmed that Steam then launched the game. This
demonstrates the cause: the launch option was missing. The repository's Steam
deployment reference correctly records that Steamworks launch settings are
manual and outside CI validation.

Issue #149 now records the build, manifest, launch-option repair, and successful
launch. It was closed with reason `completed` on 2026-09-27.

## Conclusion

The build deployed, installed, and launched through Steam. The issue's
acceptance criteria are met and its resolution is recorded on #149.

No code change was needed. Steamworks had no Windows launch option for the
player executable. Adding the `Doughby.exe` launch option fixed Steam launch.

## Next action

Recheck issue #149 and central `main` after the progress record merges.

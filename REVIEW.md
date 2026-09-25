# Review instructions

hydrust-vscode is a VS Code extension that finds and launches the hydrust
language server. It runs on a single developer's machine, inside a trusted
workspace, as that developer. Reviews are fed into an automated fix loop, so
every finding you raise will probably be implemented. Raise only findings that
are worth the code they will add.

## Proportionality comes first

- Only flag defects that this diff introduces or makes worse. Do not audit
  surrounding code the diff did not touch.
- Weigh each finding against the complexity its fix would add. If a fix for an
  unlikely edge case would add more than a few lines, or a new timer, process,
  or state flag, recommend documenting the limitation (or a **Hydrust: Restart
  Server** workaround) instead of the fix.
- When reviewing a commit that addresses earlier review findings, judge whether
  the fix is proportionate to the problem. Unnecessary complexity added by a fix
  is itself a finding, and simplifying or reverting it is a valid
  recommendation.
- Do not raise a new edge case inside code that exists only to handle another
  edge case, unless it causes a crash, hang, or data loss for a realistic user.
- Do not repeat a finding that a comment on an earlier review has marked as
  intentional or won't-fix.
- A review with no findings is a good outcome. Do not pad it.

## Out of scope

Do not flag:

- Attackers who are other local users, a hostile `/tmp`, or a malicious
  interpreter or `PATH` entry. The workspace is already trusted, and the user
  controls which interpreter is selected.
- PID or process-group reuse, and races that need precise timing between the OS
  scheduler and Node's event loop.
- Resource leaks bounded to one short-lived child process or temp directory per
  server start.
- Behaviour on platforms or environment layouts the extension does not claim to
  support.
- Test suites that cannot run in the review sandbox because no hydrust binary
  or network is available (`test:contract`, `test:table-audit`).

## Worth flagging

These are cheap to fix and repeatedly turned out to be real:

- **Comments that state something the code does not do.** If a comment says a
  branch only runs on one platform, or that an invariant holds, check it.
  Comment and docstring mistakes are fine to report at Low.
- **Docs that contradict behaviour.** If the diff changes caching, retries, or
  when work is redone, check README and CHANGELOG claims about it.
- **Caching a failure as a definitive answer.** A timeout or spawn failure must
  not be stored as "not installed" in `globalState` or a session cache.
- **Tests weaker than their name.** Ask whether a regression in the behaviour
  the test names would still pass it.
- **Tests that depend on the developer's machine or the network,** such as
  system-installed packages or a live download.
- **A promise that can fail to settle,** or settle paths (timeout, `error`,
  `close`) that disagree about the result for the same outcome.

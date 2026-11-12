# Contributing to the Hydrust extension

Thank you for your interest in the Hydrust VS Code extension. This page explains
how to send a change. Most features live in the language server,
[m-lyon/hydra-lsp](https://github.com/m-lyon/hydra-lsp). This repository
installs, starts and configures that server.

## Pick an issue

- Look at the [open issues](https://github.com/m-lyon/hydrust-vscode/issues).
- Comment on the issue before you start, so two people do not do the same work.
- For a large change, or one with no issue, open an issue first and agree on the
  design.

## Send a change

1. Fork the repository and clone your fork.
2. Create a branch from `main`.
3. Make the change, and add or update the tests for it.
4. Run the checks below. CI runs the same checks.
5. Push the branch to your fork and open a pull request against `main`.

Outside contributors do not get write access. A maintainer must approve each CI
run on a pull request from a fork, so the checks start after a short wait.
Pull requests are squash-merged.

## Checks

```bash
npm ci
npm run lint
npx tsc --noEmit
npm test
```

CI also runs two suites against a server built from `m-lyon/hydra-lsp`. To run
them, clone hydra-lsp next to this repository and build it with `cargo build`:

```bash
npm run test:contract
npm run test:table-audit
```

## Before you open the pull request

- Add an entry to [CHANGELOG.md](CHANGELOG.md) for any change a user can see.
- A new server setting, diagnostic rule, or feature needs a matching entry in
  the extension's compatibility tables. **Adding a feature** in hydra-lsp's
  [AGENTS.md](https://github.com/m-lyon/hydra-lsp/blob/main/AGENTS.md) explains
  this.

## Security problems

Do not report a security problem in a public issue. See [SECURITY.md](SECURITY.md).

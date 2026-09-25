# Change Log

## [0.1.8]

- With `importStrategy: fromEnvironment`, a `hydrust` installed in the selected Python environment is now found and used ahead of one on `PATH` for hydrust versions v0.5 or greater.

## [0.1.7]

- Prepared for the server binary being renamed to `hydrust` in server `v0.5.0`: releases, downloaded archives and cached binaries are recognised under either name, and the language server is now started with the `server` subcommand. Works unchanged against every server released so far, and against a `hydra-lsp` already on `PATH`

## [0.1.6]

- Fixed the extension failing to start when the GitHub API rate limit is exhausted
- Downloaded server binaries are now kept in global storage, so they survive extension updates
- The resolved `latest` server version is cached for a day, so starting the server no longer contacts GitHub when a binary is already installed
- `latest` is now resolved from the GitHub releases page, which is not subject to the API rate limit. The API is only used as a fallback, backing off after a rate-limit response
- If no version can be resolved and nothing is installed, a known-good server release is downloaded instead
- Added timeouts to server version and download requests

## [0.1.5]

- Updated for hydrust server `v0.4.0`
- Added `hydrust.numThreads` setting to control how many threads the server uses for analysis
- Removed the client-side `yaml` file watcher, as the server now registers the watchers it needs (`.py`, `.pyi`, and `.pth` files) itself
- Added `parameter-already-assigned` and `too-many-positional-arguments` to the rules accepted by `hydrust.disabledRules`, and replaced the removed `invalid-target` rule with `invalid-hydra-parameter`
- Added a server compatibility layer that works out what the running server version understands, and logs the settings and `disabledRules` entries it will ignore
- Added a `Hydrust: Show server info` command, which writes the resolved server version, the binary path, how it was found and any inactive settings to the output channel
- Removed the `hydrust.logLevel` setting, which no server version has ever read. Use the built-in `Developer: Set Log Level...` command to change the verbosity of the Hydrust output channels

## [0.1.4]

- Added fallback to on-disk executable if latest version search fails.

## [0.1.3]

- Fix to server restart race condition when reloading VSCode window

## [0.1.2]

- Updated docs for hydrust server `v0.3.0`
- Added server refresh for changes to `ms-python.python` interpreter path

## [0.1.1]

- Added feature toggles

## [0.1.0]

- Initial release
- Basic LSP client implementation
- Server startup and lifecycle management
- Logging and error handling
- Configuration settings for binary path, Python interpreter, and import strategy
- Commands for restarting server and viewing logs

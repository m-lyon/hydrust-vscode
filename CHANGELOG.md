# Change Log

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

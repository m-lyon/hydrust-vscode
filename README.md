# Hydrust

A VS Code extension providing intelligent language features for [Hydra](https://hydra.cc/) configuration files. Powered by a fast Rust-based language server.

If you use Hydra's `_target_` pattern to instantiate Python objects from YAML config files, Hydrust gives you hover documentation, go-to-definition, diagnostics, signature help, and semantic highlighting. Supports the full set of Hydra special keys: `_target_`, `_args_`, `_convert_`, and `_recursive_`.

## Features

Hydrust provides several intelligent features, each of which can be individually enabled or disabled in settings.

### Hover Information

Hover over a `_target_` value to see the resolved Python class or function signature, including parameter types, defaults, and docstrings.

### Go to Definition

Jump directly from a `_target_` string in a Hydra `yaml` file to the corresponding Python source definition.

### Diagnostics

Real-time validation of your Hydra configs:

- Missing required parameters
- Unknown parameters
- Unresolved references and imports
- Invalid values for Hydra special keys
- Parameters provided both positionally via `_args_` and as keyword arguments

Individual diagnostic rules can be disabled globally via the `hydrust.disabledRules` setting, or suppressed directly in your `yaml` files using `# hydrust: ignore[...]` comments.

**File-wide suppression** — place ignore comments in the file header (before any YAML content) to suppress rules for the entire file:

```yaml
# hydrust: ignore[missing-argument, unknown-argument]

db:
  _target_: my_module.DB
  host: localhost
```

**Inline suppression** — append an ignore comment to a specific line:

```yaml
db:
  _target_: my_module.DB
  host: localhost  # hydrust: ignore[unknown-argument]
```

Available rules: `missing-argument`, `unknown-argument`, `unresolved-reference`, `unresolved-import`, `invalid-hydra-parameter`, `parameter-already-assigned`, `too-many-positional-arguments`.

### Signature Help

Displays parameter information as you type, showing parameter names, types, and default values. Supports both keyword parameters for `_target_` and positional arguments within `_args_` sequences.

### Semantic Highlighting

Provides rich syntax highlighting for Hydra `yaml` files, colouring module paths, class & function names, parameter keys, and values with distinct token types.

## Finding the Server

The extension looks for the `hydrust` server in this order:

1. `hydrust.serverPath`, if set
2. With `hydrust.importStrategy` set to `fromEnvironment` (the default):
   1. A `hydrust` installed in the selected Python environment, for example with
      `uv add --dev hydrust` or `pip install hydrust`. The extension asks the
      interpreter where the package put its binary, so this works even when the
      environment is not activated and its scripts directory is not on `PATH`.
      Requires server v0.5.0 or later, the first release published to PyPI.
   2. `hydrust` (or the older `hydra-lsp`) on `PATH`
3. A server downloaded by the extension, at `hydrust.serverVersion`

The Python environment wins over `PATH` even when the copy on `PATH` is newer,
so the editor runs the same version as `hydrust check` in that environment.
The lookup uses the interpreter from `hydrust.pythonInterpreterPath`, or the
Python extension's active interpreter. The remaining fallbacks listed below are
applied by the server itself, so no environment lookup happens for them.

The interpreter is asked on every server start, which costs one Python
startup. If it fails, hangs for more than 5 seconds, or reports a binary that is
missing or older than v0.5.0, the extension carries on to `PATH`.

## Python Environment Detection

Hydrust automatically detects your Python environment using the following priority:

1. `hydrust.pythonInterpreterPath` setting (if configured)
2. Python extension's active interpreter
3. `VIRTUAL_ENV` environment variable
4. `CONDA_PREFIX` environment variable
5. `.venv` directory in workspace root
6. System Python

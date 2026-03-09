# Hydrust

A VS Code extension providing intelligent language features for [Hydra](https://hydra.cc/) configuration files. Powered by a fast Rust-based language server.

If you use Hydra's `_target_` pattern to instantiate Python objects from YAML config files, Hydrust gives you hover documentation, go-to-definition, diagnostics, signature help, and semantic highlighting.

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

Available rules: `missing-argument`, `unknown-argument`, `unresolved-reference`, `unresolved-import`, `invalid-target`.

### Signature Help

Displays parameter information as you type, showing parameter names, types, and default values.

### Semantic Highlighting

Provides rich syntax highlighting for Hydra `yaml` files, colouring module paths, class & function names, parameter keys, and values with distinct token types.

## Python Environment Detection

Hydrust automatically detects your Python environment using the following priority:

1. `hydrust.pythonInterpreterPath` setting (if configured)
2. Python extension's active interpreter
3. `VIRTUAL_ENV` environment variable
4. `CONDA_PREFIX` environment variable
5. `.venv` directory in workspace root
6. System Python

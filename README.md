# hydrust-vscode

Hydrust VSCode Extension

## Installation

1. Install the project: `npm install`
2. Build the extension: `npx vsce package`
3. On VSCode Command Palette select "Extensions: Install from VSIX..."

## Features

### Currently Implemented

- ✅ **YAML Parsing**: Extracts `_target_` references and their parameters
- ✅ **Hover Support**: Shows rich information when hovering over `_target_` values:
  - Function signatures with parameter details
  - Class information and docstrings
  - Type annotations
- ✅ **Go to Definition**: Jump from YAML `_target_` to Python source file
- ✅ **Diagnostics**: Parameter validation including:
  - Unknown parameters (unless `**kwargs` present)
  - Missing required parameters
  - Basic `_target_` format validation
- ✅ **Semantic Tokens**: Rich syntax highlighting for Hydra configurations:
  - Module path components (namespace tokens)
  - Class and function names
  - Parameter keys (parameter tokens)
  - Values (string, number, and property tokens)
- ✅ **Signature Help**: Shows parameter information while typing function arguments

### Planned Features

- 🔄 **Type Validation**: Validate YAML values against Python type annotations
- 🔄 **Smart Autocomplete**: Suggest Python classes/functions and parameters

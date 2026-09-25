"""Print where the `hydrust` package in this environment installed its binary.

Prints nothing when the package is not installed. Run as a script rather than
with `-c`, so `sys.path` starts with this directory instead of the working
directory.
"""

import os
import sys

try:
    from hydrust import find_hydrust_bin
except ImportError:
    sys.exit(0)

# The extension reads stdout as UTF-8, which the console encoding on Windows
# may not be.
sys.stdout.reconfigure(encoding="utf-8")
print(os.fsdecode(find_hydrust_bin()))

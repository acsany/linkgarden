"""Fail CI if tracked source contains likely private material.

This small guard complements a full secret scanner; it has no production credentials.
"""
from pathlib import Path
import re
import subprocess
import sys

RULES = {
    "personal email": re.compile(r"[\w.+-]+@" + r"(?:gmail|googlemail)\.com", re.I),
    "machine path": re.compile(r"/" + r"Users/[^/\s]+/|[A-Z]:\\\\Users\\\\[^\\\\\s]+\\\\", re.I),
    "Linkgarden bearer token": re.compile(r"lg_" + r"[A-Za-z0-9_-]{40,}"),
    "private key": re.compile(r"-----BEGIN " + r"(?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    "password hash": re.compile(r"scrypt\$32768\$8\$1\$" + r"[a-f0-9]{32}\$[a-f0-9]{128}"),
}
files = subprocess.check_output(["git", "ls-files", "-z"]).decode().split("\0")
found = []
for name in filter(None, files):
    try:
        content = Path(name).read_text(encoding="utf-8")
    except (UnicodeDecodeError, OSError):
        continue
    for label, pattern in RULES.items():
        for match in pattern.finditer(content):
            line = content.count("\n", 0, match.start()) + 1
            found.append(f"{name}:{line}: {label}")
if found:
    print("\n".join(found), file=sys.stderr)
    sys.exit(1)
print(f"Source guard passed for {len(files) - 1} tracked files.")

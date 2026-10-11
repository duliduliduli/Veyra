"""Object storage adapter. Local filesystem now; S3 behind the same interface later.

Keys are built only from server-generated identifiers - never user filenames (§16.2).
"""

from __future__ import annotations

import hashlib
import re
from pathlib import Path

_SEGMENT = re.compile(r"^[A-Za-z0-9._-]{1,128}$")


class ObjectStore:
    def __init__(self, root: Path):
        self.root = root.resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def _path(self, key: str) -> Path:
        parts = key.split("/")
        if not parts or any(not _SEGMENT.match(p) or p in (".", "..") for p in parts):
            raise ValueError(f"invalid object key {key!r}")
        return self.root.joinpath(*parts)

    def put(self, key: str, data: bytes) -> str:
        path = self._path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".tmp")
        tmp.write_bytes(data)
        tmp.replace(path)
        return "sha256:" + hashlib.sha256(data).hexdigest()

    def get(self, key: str) -> bytes:
        return self._path(key).read_bytes()

    def exists(self, key: str) -> bool:
        return self._path(key).is_file()

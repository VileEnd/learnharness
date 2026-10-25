import hashlib
import json
from pathlib import Path


class Cache:
    def __init__(self, root):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)

    def _path(self, parts):
        key = hashlib.sha256("\x00".join(str(p) for p in parts).encode()).hexdigest()
        return self.root / f"{key}.json"

    def get(self, *parts):
        p = self._path(parts)
        return json.loads(p.read_text()) if p.exists() else None

    def put(self, value, *parts):
        self._path(parts).write_text(json.dumps(value))

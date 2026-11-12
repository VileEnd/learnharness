# Deploy script tests

Tests for `deploy/nixos/wg-apply.py` and `deploy/nixos/deploy.py`, with Python 3.10+ and no dependencies (no root, no `wg`, no Docker, no git remote, no network):

```sh
python3 -I -B -m unittest discover -s tests/deploy -v
```

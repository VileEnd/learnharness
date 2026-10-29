# Deploy script tests

Tests for `deploy/nixos/wg-apply.py`, with Python 3.10+ and no dependencies (no root, no `wg`):

```sh
python3 -I -B -m unittest discover -s tests/deploy -v
```

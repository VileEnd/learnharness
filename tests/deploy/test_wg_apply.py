"""deploy/nixos/wg-apply.py: peers.json -> wg syncconf file, wg dump -> status.json."""

import base64
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[2] / "deploy" / "nixos" / "wg-apply.py"


def load():
    spec = importlib.util.spec_from_file_location("wg_apply", SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def key(n):
    return base64.b64encode(bytes([n]) * 32).decode()


KEY_A, KEY_B, KEY_C, KEY_D, KEY_E, KEY_F, PSK = (key(n) for n in range(1, 8))
INJECTED = "\n[Interface]\nPrivateKey = x"


def peer(n, key, ip, **extra):
    return {"id": f"p{n}", "userId": "u", "name": f"dev{n}", "publicKey": key, "presharedKey": PSK,
            "ip": ip, "createdAt": "2026-10-29T00:00:00Z", **extra}


class DryRun(unittest.TestCase):
    def test_only_the_valid_peer_is_written_and_never_its_name(self):
        with tempfile.TemporaryDirectory() as d:
            peers = [
                peer(1, KEY_A, "10.66.0.2", name=INJECTED),  # the one valid peer
                peer(2, "not-a-key", "10.66.0.3"),  # bad key
                peer(3, KEY_B, "10.67.0.4"),  # outside 10.66.0.0/24
                peer(4, KEY_C, "10.66.0.2"),  # duplicate IP
                peer(5, KEY_D, "10.66.0.5", revokedAt="2026-10-29T01:00:00Z"),  # revoked
                peer(6, KEY_E, "10.66.0.1"),  # the server's own address
                peer(7, "B" * 43 + "=", "10.66.0.7"),  # 32 bytes, but non-canonical base64 (wg refuses it)
                peer(8, KEY_F, "10.66.0.8", presharedKey="short"),  # bad preshared key
            ]
            Path(d, "peers.json").write_text(json.dumps({"version": 1, "peers": peers}))
            private = Path(d, "private")
            private.write_text(key(9) + "\n")
            out = subprocess.run(
                [sys.executable, "-I", "-B", str(SCRIPT), "--dir", d, "--private-key", str(private), "--dry-run"],
                capture_output=True, text=True, check=True,
            ).stdout
            self.assertEqual(out.count("[Peer]"), 1)
            self.assertEqual(out.count("[Interface]"), 1)
            self.assertNotIn("PrivateKey = x", out)
            self.assertIn(f"PublicKey = {KEY_A}\nPresharedKey = {PSK}\nAllowedIPs = 10.66.0.2/32", out)
            self.assertEqual(sorted(os.listdir(d)), ["peers.json", "private"])  # dry run writes nothing


class Parsers(unittest.TestCase):
    def test_status_from_wg_dump(self):
        dump = (
            "privkey\tpubkey\t51820\toff\n"
            f"{KEY_A}\t{PSK}\t(none)\t10.66.0.2/32\t0\t0\t0\toff\n"
            f"{KEY_B}\t{PSK}\t203.0.113.7:4500\t10.66.0.3/32\t1761700000\t10\t20\toff\n"
        )
        self.assertEqual(load().parse_dump(dump), {
            KEY_A: {"latestHandshake": None, "endpoint": None},
            KEY_B: {"latestHandshake": 1761700000, "endpoint": "203.0.113.7:4500"},
        })

    def test_allowed_ips_from_the_default_route(self):
        route = "default via 192.168.178.1 dev ens18 proto dhcp src 192.168.178.20 metric 1002\n"
        addr = "2: ens18    inet 192.168.178.20/24 brd 192.168.178.255 scope global dynamic noprefixroute ens18\\       valid_lft 860000sec preferred_lft 860000sec\n"
        mod = load()
        self.assertEqual(mod.default_dev(route), "ens18")
        self.assertEqual(mod.first_inet(addr), "192.168.178.20")


if __name__ == "__main__":
    unittest.main()

#!/usr/bin/env python3
"""WireGuard peer applier for the LearnHarness VM (deploy/nixos/wireguard.nix).

Runs as root. The app container (uid 1000) owns the data directory and writes
peers.json there; this script is the only bridge to the host, and the only
thing it takes from that file is, per peer, a public key, a preshared key and
an address inside 10.66.0.0/24. Invalid entries are logged (by index, never by
name) and skipped. Each run:

  1. writes server.json  {publicKey, endpoint, allowedIps}       (0644)
  2. applies peers.json  with `wg syncconf` (skipped with --status-only)
  3. writes status.json  {updatedAt, peers: {pubkey: {latestHandshake}}}

--dry-run prints the syncconf file (it holds secrets) and touches nothing.
Standard library only.
"""

import argparse
import base64
import binascii
import ipaddress
import json
import os
import re
import secrets
import stat
import subprocess
import sys
import tempfile
import time

SUBNET = ipaddress.IPv4Network("10.66.0.0/24")
RESERVED = {SUBNET.network_address, SUBNET.network_address + 1, SUBNET.broadcast_address}
MAX_PEERS_FILE = 1 << 20
CONTROL = re.compile(r"[\x00-\x1f\x7f]")


class Refused(Exception):
    """A whole input is unusable; the step that needs it is skipped."""


def log(msg):
    print(f"wg-apply: {msg}", file=sys.stderr, flush=True)


def is_key(v):
    """A WireGuard key: 44 characters of canonical base64 for exactly 32 bytes (wg refuses anything else)."""
    if not isinstance(v, str) or len(v) != 44:
        return False
    try:
        raw = base64.b64decode(v, validate=True)
    except (binascii.Error, ValueError):
        return False
    return len(raw) == 32 and base64.b64encode(raw).decode("ascii") == v


def peer_ip(v):
    if not isinstance(v, str):
        return None
    try:
        ip = ipaddress.IPv4Address(v)
    except ValueError:
        return None
    return ip if ip in SUBNET and ip not in RESERVED and str(ip) == v else None


def valid_peers(raw):
    """The usable peers in file order. On a duplicate address or key the first entry wins."""
    out, ips, keys = [], set(), set()
    for i, p in enumerate(raw):
        ident = f"#{i}"
        if isinstance(p, dict) and isinstance(p.get("id"), str):
            ident += f" (id {p['id'][:64]!r})"
        if not isinstance(p, dict):
            log(f"skipping peer {ident}: not an object")
            continue
        if "revokedAt" in p:
            continue
        ip = peer_ip(p.get("ip"))
        why = (
            "invalid publicKey" if not is_key(p.get("publicKey"))
            else "invalid presharedKey" if not is_key(p.get("presharedKey"))
            else "ip outside 10.66.0.2-254" if ip is None
            else "duplicate ip" if ip in ips
            else "duplicate publicKey" if p["publicKey"] in keys
            else None
        )
        if why:
            log(f"skipping peer {ident}: {why}")
            continue
        ips.add(ip)
        keys.add(p["publicKey"])
        out.append({"publicKey": p["publicKey"], "presharedKey": p["presharedKey"], "ip": str(ip)})
    return out


def render_conf(private_key, listen_port, peers):
    lines = ["[Interface]", f"PrivateKey = {private_key}", f"ListenPort = {listen_port}", ""]
    for p in peers:
        lines += ["[Peer]", f"PublicKey = {p['publicKey']}", f"PresharedKey = {p['presharedKey']}",
                  f"AllowedIPs = {p['ip']}/32", ""]
    return "\n".join(lines)


def parse_dump(text):
    """`wg show <if> dump` -> {pubkey: {latestHandshake: unix seconds | None}}.

    The peers' endpoints (their public IPs) are deliberately not recorded."""
    peers = {}
    for line in text.splitlines()[1:]:  # the first line is the interface itself
        f = line.split("\t")
        if len(f) < 5 or not is_key(f[0]):
            continue
        try:
            hs = int(f[4])
        except ValueError:
            hs = 0
        peers[f[0]] = {"latestHandshake": hs or None}
    return peers


def default_dev(route_text):
    """The interface of the first IPv4 default route in `ip -4 route show default`."""
    for line in route_text.splitlines():
        m = re.match(r"default\b.*?\bdev\s+(\S+)", line)
        if m:
            return m.group(1)
    return None


def first_inet(addr_text):
    """The first IPv4 address in `ip -4 -o addr show dev <if>`."""
    m = re.search(r"\binet\s+(\d{1,3}(?:\.\d{1,3}){3})/\d+", addr_text)
    if not m:
        return None
    try:
        return str(ipaddress.IPv4Address(m.group(1)))
    except ValueError:
        return None


def run(*cmd, stdin=None):
    return subprocess.run(cmd, input=stdin, capture_output=True, text=True, check=True).stdout


def lan_ipv4():
    dev = default_dev(run("ip", "-4", "route", "show", "default"))
    if not dev:
        raise Refused("no IPv4 default route")
    ip = first_inet(run("ip", "-4", "-o", "addr", "show", "dev", dev))
    if not ip:
        raise Refused(f"no IPv4 address on {dev}")
    return ip


def read_private_key(path):
    with open(path, encoding="ascii") as f:
        key = f.read().strip()
    if not is_key(key):
        raise Refused(f"{path} does not hold a WireGuard private key")
    return key


# --- the data directory belongs to the app (uid 1000) ------------------------
# Everything below works relative to a directory fd opened without following
# symlinks and checked against its real location, so a planted symlink can't
# steer root's reads and writes elsewhere.

def open_dir(path, create):
    """An fd for `path`, never following symlinks. `create` = how many missing levels
    may be made (0 = none, 2 = the dir and its parent); the topmost existing ancestor
    (the app's data dir) must already exist. Returns None when it does not."""
    path = os.path.abspath(path)
    try:
        fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    except FileNotFoundError:
        if not create:
            return None
        parent = open_dir(os.path.dirname(path), create=int(create) - 1 if create else 0)
        if parent is None:
            return None  # the app has not created its data dir yet
        try:
            st = os.fstat(parent)
            os.mkdir(os.path.basename(path), 0o700, dir_fd=parent)
        except FileExistsError:
            st = None
        finally:
            os.close(parent)
        fd = open_dir(path, create=0)
        if st is not None and fd is not None:
            # Through the verified fd, never by name: the parent is the app's.
            if os.geteuid() == 0:  # only root can hand it to the app (uid 1000), which writes peers.json here
                os.fchown(fd, st.st_uid, st.st_gid)
            os.fchmod(fd, 0o755)
        return fd
    if os.readlink(f"/proc/self/fd/{fd}") != path:
        os.close(fd)
        raise Refused(f"{path} resolves elsewhere (symlink in the path)")
    return fd


def load_peers(dfd):
    """The peers list, [] when there is no file yet. Refused when the file is unusable as a whole."""
    if dfd is None:
        return []
    try:
        fd = os.open("peers.json", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=dfd)
    except FileNotFoundError:
        return []
    except OSError as e:
        raise Refused(f"peers.json: cannot open ({e.strerror})") from None
    with os.fdopen(fd, "rb") as f:
        st = os.fstat(f.fileno())
        if not stat.S_ISREG(st.st_mode) or st.st_size > MAX_PEERS_FILE:
            raise Refused("peers.json is not a regular file of sane size")
        data = f.read(MAX_PEERS_FILE + 1)
    try:
        doc = json.loads(data)
    except ValueError:
        raise Refused("peers.json is not valid JSON") from None
    if not isinstance(doc, dict) or doc.get("version") != 1 or not isinstance(doc.get("peers"), list):
        raise Refused("peers.json is not a version 1 peers file")
    return doc["peers"]


def write_json(dfd, name, obj):
    """Atomic, 0644, owned by root: a fresh O_EXCL temp name, then rename over `name`."""
    data = (json.dumps(obj, indent=2) + "\n").encode()
    tmp = f".{name}.{secrets.token_hex(8)}"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=dfd)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            os.fchmod(f.fileno(), 0o644)
        os.rename(tmp, name, src_dir_fd=dfd, dst_dir_fd=dfd)
    except BaseException:
        try:
            os.unlink(tmp, dir_fd=dfd)
        except OSError:
            pass
        raise


# --- the three steps ----------------------------------------------------------

def write_server(dfd, private_key, endpoint):
    public_key = run("wg", "pubkey", stdin=private_key + "\n").strip()
    if not is_key(public_key):
        raise Refused("wg pubkey returned no key")
    write_json(dfd, "server.json", {"publicKey": public_key, "endpoint": endpoint, "allowedIps": f"{lan_ipv4()}/32"})


def apply_peers(dfd, private_key, interface, listen_port):
    peers = valid_peers(load_peers(dfd))
    fd, conf = tempfile.mkstemp(prefix="wg-apply-", suffix=".conf")  # 0600
    try:
        with os.fdopen(fd, "w") as f:
            f.write(render_conf(private_key, listen_port, peers))
        run("wg", "syncconf", interface, conf)
    finally:
        os.unlink(conf)
    log(f"applied {len(peers)} peer(s) to {interface}")


def write_status(dfd, interface):
    write_json(dfd, "status.json", {"updatedAt": int(time.time()), "peers": parse_dump(run("wg", "show", interface, "dump"))})


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--dir", required=True, help="the shared wireguard data directory")
    ap.add_argument("--private-key", required=True, help="the server's private key file")
    ap.add_argument("--interface", default="wg0")
    ap.add_argument("--listen-port", type=int, default=51820)
    ap.add_argument("--endpoint", default="vpn.moyjak.com:51820", help="host:port written to server.json")
    ap.add_argument("--status-only", action="store_true", help="refresh server.json and status.json, leave peers alone")
    ap.add_argument("--dry-run", action="store_true", help="print the syncconf file and change nothing")
    a = ap.parse_args(argv)
    if CONTROL.search(a.endpoint) or not a.endpoint:
        ap.error("--endpoint must be a plain host:port")

    try:
        private_key = read_private_key(a.private_key)
    except (OSError, Refused) as e:
        log(f"no server key: {e}")
        return 1

    if a.dry_run:
        dfd = None
        try:
            dfd = open_dir(a.dir, create=False)
            sys.stdout.write(render_conf(private_key, a.listen_port, valid_peers(load_peers(dfd))))
        except Refused as e:
            log(str(e))
            return 1
        finally:
            if dfd is not None:
                os.close(dfd)
        return 0

    try:
        dfd = open_dir(a.dir, create=2)  # wireguard/, and global/ on a fresh install
    except (OSError, Refused) as e:
        log(f"data dir unusable: {e}")
        return 1
    if dfd is None:
        log(f"{os.path.dirname(os.path.abspath(a.dir))} does not exist yet (app not started); nothing to do")
        return 0

    steps = [("server.json", lambda: write_server(dfd, private_key, a.endpoint))]
    if not a.status_only:
        steps.append(("apply", lambda: apply_peers(dfd, private_key, a.interface, a.listen_port)))
    steps.append(("status.json", lambda: write_status(dfd, a.interface)))
    rc = 0
    try:
        for name, step in steps:
            try:
                step()
            except Refused as e:
                log(f"{name}: {e}")
                rc = 1
            except subprocess.CalledProcessError as e:
                log(f"{name}: {e.cmd[0]} {e.cmd[1]} failed ({e.returncode}): {(e.stderr or '').strip()[:300]}")
                rc = 1
            except OSError as e:
                log(f"{name}: {e}")
                rc = 1
    finally:
        os.close(dfd)
    return rc


if __name__ == "__main__":
    sys.exit(main())

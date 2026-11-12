#!/usr/bin/env python3
"""Deploys, starts and rolls back the LearnHarness stack on the NixOS VM (learnharness-stack.nix).

Runs as root from the units, which hold /var/lib/learnharness/deploy.lock (one
of these at a time) and have prepared the checkout, volumes and secrets.env.

  start        boot or restart: bring up the current deploy from its checkout
               and images; no fetch, no build. Without deploy state it starts
               the pre-existing :local stack as it is, and only a machine with
               no images at all gets a first deploy of --default-target.
  deploy T     T = latest (newest vX.Y.Z tag), a vX.Y.Z tag, or a branch: fetch,
               check out, build images tagged with the commit, bring the stack
               up on them, wait for the app to report healthy, then run the
               Keycloak bootstrap. A failed build leaves the running stack
               alone; an app that is not healthy goes back to the deploy
               before. Afterwards only the current and the previous deploy
               keep images.
  rollback     swap current and previous: check out the previous commit and
               bring its images up, without building or pulling. Refused when
               a third-party image (Keycloak, Postgres, oauth2-proxy) differs
               between the two, unless --force. Twice returns.
  prune -- C   run the prune command C (the weekly docker system prune) while
               stopped containers hold the images of the current and previous
               deploy, so a rollback target is never pruned. If one cannot be
               held, nothing is pruned.

State: deploy-state.json {version, current, previous, pending}, each {target,
commit, tag, time}; `pending` names a deploy between its `up` and its final
record. Written atomically. Exit 0 ok, 1 transient (the boot unit tries
again), 3 failed for good (it does not). Standard library only.
"""

import argparse
import json
import os
import re
import secrets
import subprocess
import sys
import time
from datetime import datetime, timezone

STATE_VERSION = 1
# compose service -> image repository; compose builds these, tagged per deploy.
SERVICES = {
    "learnharness": "learnharness",
    "caddy": "learnharness-caddy",
    "ocr": "learnharness-ocr",
    "claude": "learnharness-claude",
}
APP_CONTAINER = "learnharness-learnharness-1"
KEEPER_PREFIX = "learnharness-keep-"
RELEASE = re.compile(r"^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$")
# Image tags this script owns: the first 12 hex digits of a commit, or the
# pre-deploy "local" (also the compose default for a manual install).
OUR_TAG = re.compile(r"^(?:[0-9a-f]{12}|local)$")
COMMIT = re.compile(r"^(?:[0-9a-f]{40}|[0-9a-f]{64})$")
TARGET = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$")
MAX_STATE = 64 * 1024
EXIT_RETRY = 1
EXIT_FAILED = 3
# Seconds per step, so a hung step fails here and the deploy goes back, well
# inside the units' TimeoutStartSec (deploy 60 min, rollback 30 min).
T_GIT = 120
T_FETCH = 300
T_BUILD = 25 * 60
T_UP = 300
T_RELOAD = 60
T_INSPECT = 30
# Where an on-disk format change shows: the fixture law updates these files in
# the same commit (CLAUDE.md, "Fixture law").
FORMAT_PATHS = "tests/fixtures/golden-data"


class Refused(Exception):
    """An input is unusable; nothing was changed."""


class Failed(Exception):
    """A command failed."""


# --- decisions (pure) --------------------------------------------------------

def newest_release(tags):
    """The highest vMAJOR.MINOR.PATCH by version order, or None."""
    best = None
    for t in tags:
        m = RELEASE.match(t)
        if m:
            key = tuple(int(x) for x in m.groups())
            if best is None or key > best[0]:
                best = (key, t)
    return best and best[1]


def valid_target(t):
    return bool(TARGET.match(t)) and ".." not in t and "//" not in t and not t.endswith(("/", ".lock", "."))


def resolve_target(target, tags, branches):
    """(name to record, ref to check out) for latest | a vX.Y.Z tag | a branch of origin."""
    if not valid_target(target):
        raise Refused(f"not a valid target: {target!r}")
    if target == "latest":
        newest = newest_release(tags)
        if newest is None:
            raise Refused("latest: there is no vX.Y.Z release tag")
        return newest, f"refs/tags/{newest}"
    if target in tags:
        return target, f"refs/tags/{target}"
    if target in branches:
        return target, f"refs/remotes/origin/{target}"
    raise Refused(f"no tag or branch named {target!r} on origin")


def image_tag(commit):
    return commit[:12]


def supports_tagged_images(compose_text):
    """Whether this compose.yaml takes its built images' tag from LH_IMAGE_TAG.

    An older one builds and runs :local whatever the deploy asks for."""
    return all(
        re.search(rf"^\s*image:\s*{re.escape(repo)}:\$\{{LH_IMAGE_TAG:-local\}}\s*$", compose_text, re.M)
        for repo in SERVICES.values()
    )


def third_party_images(compose_text):
    """{service: image} for every service image in compose.yaml that is not one of ours."""
    out, svc, in_services = {}, None, False
    for line in compose_text.splitlines():
        if re.match(r"^\S", line):
            in_services, svc = line.rstrip() == "services:", None
        elif in_services and (m := re.match(r"^  ([A-Za-z0-9_.-]+):\s*$", line)):
            svc = m.group(1)
        elif in_services and svc and (m := re.match(r"^    image:\s*(\S+)\s*$", line)):
            if m.group(1).partition(":")[0] not in SERVICES.values():
                out[svc] = m.group(1)
    return out


def image_differences(now, then):
    """[(service, image now, image then)] where the two differ (None = absent)."""
    return [(s, now.get(s), then.get(s)) for s in sorted(set(now) | set(then)) if now.get(s) != then.get(s)]


def record(target, commit, tag, now):
    return {"target": target, "commit": commit, "tag": tag, "time": now}


def valid_record(r):
    return (
        isinstance(r, dict)
        and set(r) == {"target", "commit", "tag", "time"}
        and isinstance(r["target"], str) and 0 < len(r["target"]) <= 200
        and isinstance(r["commit"], str) and bool(COMMIT.match(r["commit"]))
        and isinstance(r["tag"], str) and bool(OUR_TAG.match(r["tag"]))
        and isinstance(r["time"], str) and len(r["time"]) <= 64
    )


def make_state(current, previous=None, pending=None):
    return {"version": STATE_VERSION, "current": current, "previous": previous, "pending": pending}


def read_state(path):
    """The state, None when there is no file. Refused when it exists but is unusable."""
    try:
        with open(path, "rb") as f:
            data = f.read(MAX_STATE + 1)
    except FileNotFoundError:
        return None
    except OSError as e:
        raise Refused(f"{path}: cannot read ({e.strerror})") from None
    try:
        doc = json.loads(data)
    except ValueError:
        raise Refused(f"{path} is not valid JSON") from None
    if not isinstance(doc, dict) or doc.get("version") != STATE_VERSION:
        raise Refused(f"{path} is not a version {STATE_VERSION} deploy state")
    if not valid_record(doc.get("current")) or not all(
        doc.get(k) is None or valid_record(doc[k]) for k in ("previous", "pending")
    ):
        raise Refused(f"{path} has an invalid current, previous or pending deploy")
    return make_state(doc["current"], doc.get("previous"), doc.get("pending"))


def write_state(path, state):
    """Atomic: a fresh temp file in the same directory, fsynced, renamed over `path`."""
    d = os.path.dirname(os.path.abspath(path))
    tmp = os.path.join(d, f".{os.path.basename(path)}.{secrets.token_hex(8)}")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o644)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write((json.dumps(state, indent=2) + "\n").encode())
            f.flush()
            os.fchmod(f.fileno(), 0o644)
            os.fsync(f.fileno())
        os.rename(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    dfd = os.open(d, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(dfd)
    finally:
        os.close(dfd)


def after_deploy(state, before, new):
    """`before` (the deploy that was running) becomes previous; a redeploy of the same commit keeps previous."""
    if before is not None and before["commit"] == new["commit"]:
        previous = state["previous"] if state else None
    else:
        previous = before
    return make_state(new, previous)


def after_rollback(state):
    return make_state(state["previous"], state["current"])


def images_of(tag):
    return {f"{repo}:{tag}" for repo in SERVICES.values()}


def plan_start(state, images):
    """What a boot does, given the state and the local images ("repo:tag"):
    ("up", current) | ("legacy", None) | ("deploy", None) | ("refuse", why)."""
    if state is not None:
        cur = state["current"]
        if not images_of(cur["tag"]) <= set(images):
            return "refuse", (f"the images of the current deploy ({cur['target']}, tag {cur['tag']}) are missing; "
                              "deploy again with learnharness-deploy@<target>")
        return "up", cur
    if images_of("local") <= set(images):
        return "legacy", None
    if "learnharness" in {i.split(":", 1)[0] for i in images}:
        return "refuse", ("app images exist but there is no deploy state; "
                          "record one with learnharness-deploy@<target>")
    return "deploy", None


def stale_images(images, keep_tags):
    """Our images ("repo:tag") whose tag is ours and belongs to neither kept deploy."""
    out = []
    for ref in images:
        repo, _, tag = ref.partition(":")
        if repo in SERVICES.values() and OUR_TAG.match(tag) and tag not in keep_tags:
            out.append(ref)
    return out


def legacy_record(head, local_ids, running_ids, now):
    """The pre-deploy :local stack as a deploy record, only when every built
    service runs exactly its :local image (so going back to it is going back to
    what users had). head = the checkout's commit."""
    if not head or not COMMIT.match(head):
        return None
    for svc in SERVICES:
        if not local_ids.get(svc) or local_ids[svc] != running_ids.get(svc):
            return None
    return record("legacy", head, "local", now)


def health_verdict(out, tag):
    """`docker inspect` "<image> <health>" of the app -> healthy | unhealthy | waiting."""
    parts = out.split()
    if len(parts) != 2 or parts[0] != f"learnharness:{tag}":
        return "waiting"
    return parts[1] if parts[1] in ("healthy", "unhealthy") else "waiting"


def describe(r):
    return f"{r['target']} ({r['commit'][:12]})"


# --- running it ----------------------------------------------------------------

def sh(argv, capture=False, cwd=None, env=None, timeout=None):
    """(exit code, stdout); 124 when `timeout` seconds passed (the command is killed).
    Without capture, output goes to the journal."""
    try:
        p = subprocess.run(argv, cwd=cwd, env=env, text=True, timeout=timeout,
                           stdout=subprocess.PIPE if capture else None)
    except subprocess.TimeoutExpired:
        return 124, ""
    return p.returncode, p.stdout or ""


def utc_now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def stderr_log(msg):
    print(f"learnharness-deploy: {msg}", file=sys.stderr, flush=True)


class Stack:
    def __init__(self, src, state, hosts_env, secrets, keycloak_bootstrap, run=sh, sleep=time.sleep,
                 monotonic=time.monotonic, now=utc_now, log=stderr_log, health_timeout=300):
        self.src, self.state_path, self.hosts_env, self.secrets = src, state, hosts_env, secrets
        self.keycloak_bootstrap = keycloak_bootstrap
        self.run, self.sleep, self.monotonic, self.now, self.log = run, sleep, monotonic, now, log
        self.health_timeout = health_timeout
        self.write_state = write_state

    # helpers
    def do(self, argv, what, timeout, **kw):
        code, out = self.run(argv, timeout=timeout, **kw)
        if code == 124:
            raise Failed(f"{what} timed out after {timeout}s")
        if code != 0:
            raise Failed(f"{what} exited {code}")
        return out

    def out(self, argv, timeout=T_INSPECT):
        code, out = self.run(argv, capture=True, timeout=timeout)
        return out.strip() if code == 0 else None

    def git(self, *args, timeout=T_GIT):
        return self.do(["git", "-C", self.src, *args], f"git {args[0]}", timeout, capture=True)

    def compose(self, tag, *args, timeout, check=True):
        argv = ["docker", "compose", "--env-file", self.hosts_env, "--env-file", self.secrets, *args]
        kw = {"cwd": os.path.join(self.src, "deploy"), "env": {**os.environ, "LH_IMAGE_TAG": tag}}
        if check:
            self.do(argv, f"docker compose {args[0]}", timeout, **kw)
        else:
            self.run(argv, timeout=timeout, **kw)

    def images(self):
        code, out = self.run(["docker", "image", "ls", "--format", "{{.Repository}}:{{.Tag}}"], capture=True,
                             timeout=T_INSPECT)
        if code != 0:
            raise Failed("docker image ls failed (is Docker running?)")
        return {line for line in out.splitlines() if line}

    def image_id(self, ref):
        return self.out(["docker", "image", "inspect", "--format", "{{.Id}}", ref])

    def has_commit(self, commit):
        return self.run(["git", "-C", self.src, "cat-file", "-e", commit + "^{commit}"], capture=True,
                        timeout=T_GIT)[0] == 0

    def compose_at(self, commit):
        return self.git("show", f"{commit}:deploy/compose.yaml")

    def fetch(self):
        # --prune-tags: a tag withdrawn on origin stops counting for `latest`. The
        # commits the state names are pinned under refs/learnharness/, which no
        # fetch refspec covers, so they survive this and a history rewrite.
        self.do(["git", "-C", self.src, "fetch", "--prune", "--prune-tags", "--force", "--tags", "origin"],
                "git fetch", T_FETCH)

    def checkout(self, commit):
        # Only a crash leaves this behind: every git command here runs under deploy.lock.
        lock = os.path.join(self.src, ".git", "index.lock")
        if os.path.exists(lock):
            self.log("removing a stale .git/index.lock (an interrupted checkout)")
            os.unlink(lock)
        self.git("checkout", "--quiet", "--force", "--detach", commit)

    def bring_up(self, r, pull_never=False):
        """Check out r's commit (if known) and start r's images: no build.
        pull_never: a rollback or go-back never reaches for the network."""
        if r.get("commit"):
            self.checkout(r["commit"])
        self.compose(r["tag"], "up", "-d", "--no-build", "--remove-orphans",
                     *(["--pull", "never"] if pull_never else []), timeout=T_UP)
        # The Caddyfile is a bind mount: compose does not notice content changes,
        # so apply them explicitly (a no-op when nothing changed).
        self.compose(r["tag"], "exec", "-T", "caddy", "caddy", "reload", "--config", "/etc/caddy/Caddyfile",
                     "--adapter", "caddyfile", timeout=T_RELOAD, check=False)

    def bootstrap_keycloak(self):
        # Group, admin-API client and its roles in the realm, idempotently. It
        # waits up to 3 minutes for Keycloak and never fails the stack: a failure
        # only logs, and the admin Users section stays unconfigured until the
        # next start, deploy or rollback.
        code, _ = self.run(["timeout", "300", "bash", self.keycloak_bootstrap, self.secrets])
        if code != 0:
            self.log("keycloak bootstrap failed")

    def health(self, tag):
        fmt = "{{.Config.Image}} {{if .State.Health}}{{.State.Health.Status}}{{end}}"
        code, out = self.run(["docker", "inspect", "--format", fmt, APP_CONTAINER], capture=True, timeout=T_INSPECT)
        return health_verdict(out, tag) if code == 0 else "waiting"

    def wait_healthy(self, tag):
        deadline = self.monotonic() + self.health_timeout
        while True:
            verdict = self.health(tag)
            if verdict != "waiting":
                return verdict == "healthy"
            if self.monotonic() >= deadline:
                return False
            self.sleep(5)

    def legacy(self):
        """The running :local stack as a record, when it can safely be gone back to."""
        head = self.out(["git", "-C", self.src, "rev-parse", "--verify", "--quiet", "HEAD"])
        local = {svc: self.image_id(f"{repo}:local") for svc, repo in SERVICES.items()}
        running = {svc: self.out(["docker", "inspect", "--format", "{{.Image}}", f"learnharness-{svc}-1"])
                   for svc in SERVICES}
        return legacy_record(head, local, running, self.now())

    def format_note(self, started, other):
        """The journal line for every rollback and go-back: app data formats."""
        a, b = started["commit"][:12], other["commit"][:12]
        self.log(f"note: {describe(started)} cannot read records written by a newer data format than its own. "
                 f"If {describe(other)} is newer and changed one, data written since is refused: any commit listed by "
                 f"`git -C {self.src} log --oneline {a}..{b} -- {FORMAT_PATHS}` changed an on-disk format")

    def save(self, state):
        """Write the state, then pin its commits with refs so `git gc` keeps them
        even when their branch or tag is deleted on origin (best effort)."""
        self.write_state(self.state_path, state)
        for name in ("current", "previous"):
            r = state[name]
            ref = f"refs/learnharness/{name}"
            args = ["update-ref", ref, r["commit"]] if r else ["update-ref", "-d", ref]
            if self.run(["git", "-C", self.src, *args], capture=True, timeout=T_GIT)[0] != 0:
                self.log(f"could not set {ref}")

    def read_state(self):
        try:
            return read_state(self.state_path), None
        except Refused as e:
            return None, f"{e}; fix or move it away (nothing was changed)"

    # commands
    def start(self, default_target):
        state, err = self.read_state()
        if err:
            self.log(err)
            return EXIT_FAILED
        try:
            action, cur = plan_start(state, self.images())
            if action == "refuse":
                self.log(f"not starting: {cur}")
                return EXIT_FAILED
            if action == "deploy":
                self.log(f"nothing deployed on this machine yet: first deploy of {default_target}")
                return self.deploy(default_target)
            if action == "legacy":
                self.log("no deploy state: starting the :local stack from the checkout as it is")
                self.bring_up({"commit": None, "tag": "local"})
            else:
                if not self.has_commit(cur["commit"]):
                    self.log(f"not starting: the recorded commit {cur['commit'][:12]} is not in the checkout "
                             f"(re-cloned?); deploy again with learnharness-deploy@<target>")
                    return EXIT_FAILED
                if state["pending"]:
                    self.log(f"a deploy of {describe(state['pending'])} was interrupted; "
                             f"starting the recorded {describe(cur)}")
                    try:
                        self.save(make_state(cur, state["previous"]))
                    except OSError as e:
                        self.log(f"could not clear the interrupted deploy from the state ({e}); starting anyway")
                else:
                    self.log(f"starting {describe(cur)}, image tag {cur['tag']}")
                self.bring_up(cur)
        except Failed as e:
            self.log(f"start failed: {e}")
            return EXIT_RETRY
        self.bootstrap_keycloak()
        return 0

    def deploy(self, target):
        if not valid_target(target):
            self.log(f"deploy: not a valid target: {target!r}; nothing was changed")
            return EXIT_FAILED
        state, err = self.read_state()
        if err:
            self.log(err)
            return EXIT_FAILED
        before = state["current"] if state else self.legacy()
        # What the file holds while this deploy runs (no pending yet).
        base = make_state(state["current"], state["previous"]) if state else (make_state(before) if before else None)
        if state is None:
            self.log("first tagged deploy: " + (
                f"the running :local stack ({before['commit'][:12]}) becomes the rollback target" if before
                else "no running :local stack to go back to, so rollback is possible from the next deploy on"))
        try:
            self.fetch()
        except Failed as e:
            self.log(f"deploy {target}: fetch failed ({e}); nothing was changed")
            return EXIT_RETRY
        try:
            refs = self.git("for-each-ref", "--format=%(refname)", "refs/").splitlines()
            tags = {r.removeprefix("refs/tags/") for r in refs if r.startswith("refs/tags/")}
            branches = {r.removeprefix("refs/remotes/origin/") for r in refs
                        if r.startswith("refs/remotes/origin/") and r != "refs/remotes/origin/HEAD"}
            name, ref = resolve_target(target, tags, branches)
            commit = self.git("rev-parse", "--verify", "--quiet", ref + "^{commit}").strip()
            if not supports_tagged_images(self.compose_at(commit)):
                raise Refused(f"{name} ({commit[:12]}) predates per-deploy image tags "
                              "(its deploy/compose.yaml has no LH_IMAGE_TAG); deploy a newer target")
        except (Refused, Failed) as e:
            self.log(f"deploy {target}: {e}; nothing was changed")
            return EXIT_FAILED

        new = record(name, commit, image_tag(commit), self.now())
        if state and commit == state["current"]["commit"] and self.health(new["tag"]) == "healthy":
            self.log(f"{name} is {commit[:12]}, already running {new['tag']}; nothing to do")
            return 0

        self.log(f"deploying {describe(new)}, image tag {new['tag']}")
        try:
            self.checkout(commit)
            self.compose(new["tag"], "build", timeout=T_BUILD)
        except Failed as e:
            self.log(f"deploy of {describe(new)} failed: build failed ({e}); "
                     f"the running stack is untouched{self.restore_checkout(before)}")
            return EXIT_FAILED

        if base is not None:
            try:
                self.save({**base, "pending": new})
            except OSError as e:
                self.log(f"deploy of {describe(new)} stopped: the deploy state could not be written ({e}); "
                         f"the running stack is untouched{self.restore_checkout(before)}")
                return EXIT_FAILED

        reason = None
        try:
            self.bring_up(new)
            if not self.wait_healthy(new["tag"]):
                reason = f"the app is not healthy (waited up to {self.health_timeout}s)"
        except Failed as e:
            reason = f"starting it failed ({e})"

        if reason is None or before is None:
            if reason is None:
                self.bootstrap_keycloak()
            final = after_deploy(state, before, new)
            try:
                self.save(final)
            except OSError as e:
                self.log(f"{describe(new)} is running but the deploy state could not be written ({e}); "
                         "a restart would start the deploy before it: free space and deploy again")
                return EXIT_FAILED
            if reason is not None:
                self.log(f"deploy of {describe(new)} failed: {reason}, and there is no earlier deploy "
                         "to go back to: it stays up")
                return EXIT_FAILED
            self.log(f"deployed {describe(new)}")
            try:
                self.housekeep(final)
            except Failed as e:
                self.log(f"removing older images failed ({e}); the weekly prune or the next deploy will")
            return 0

        if before["tag"] == new["tag"]:
            self.save(base)
            self.log(f"deploy of {describe(new)} failed: {reason}; it is the same build as the deploy that was "
                     f"running, so there is no other build to go back to (learnharness-rollback returns to the "
                     f"previous deploy)")
            return EXIT_FAILED
        try:
            self.bring_up(before, pull_never=True)
        except Failed as e:
            self.log(f"deploy of {describe(new)} failed: {reason}; going back to {describe(before)} "
                     f"failed too ({e}): check docker compose ps")
            return EXIT_FAILED
        self.save(base)
        self.format_note(before, new)
        self.log(f"deploy of {describe(new)} failed: {reason}; back on {describe(before)}")
        return EXIT_FAILED

    def restore_checkout(self, before):
        """Put the checkout back on the running deploy's commit; '' or a note for the log line."""
        if not before:
            return ""
        try:
            self.checkout(before["commit"])
            return ""
        except Failed:
            return " (the checkout could not be put back; the next start does it)"

    def housekeep(self, state):
        """Remove images of deploys older than the previous one (none without a previous)."""
        if state["previous"] is None:
            return
        keep = {state["current"]["tag"], state["previous"]["tag"]}
        for ref in sorted(stale_images(self.images(), keep)):
            if self.run(["docker", "image", "rm", ref], capture=True, timeout=T_INSPECT)[0] == 0:
                self.log(f"removed {ref}")
            else:
                self.log(f"could not remove {ref}")

    def rollback(self, force=False):
        state, err = self.read_state()
        if err:
            self.log(err)
            return EXIT_FAILED
        if state is None or state["previous"] is None:
            self.log("rollback: there is no previous deploy to roll back to; nothing was changed")
            return EXIT_FAILED
        cur, prev = state["current"], state["previous"]
        try:
            have = self.images()
            if not images_of(prev["tag"]) <= have:
                self.log(f"rollback: the images of {describe(prev)} (tag {prev['tag']}) are gone; "
                         f"deploy it instead: learnharness-deploy@{prev['target']}; nothing was changed")
                return EXIT_FAILED
            then = third_party_images(self.compose_at(prev["commit"]))
            diffs = image_differences(third_party_images(self.compose_at(cur["commit"])), then)
        except Failed as e:
            self.log(f"rollback: {e}; nothing was changed")
            return EXIT_FAILED
        if diffs:
            listed = "; ".join(f"{svc}: {a or 'absent'} now, {b or 'absent'} in {describe(prev)}" for svc, a, b in diffs)
            if not force:
                self.log(f"rollback refused: third-party images differ ({listed}). An older Keycloak or Postgres "
                         "may not start on data the newer one migrated, and only the app's health is checked. "
                         "To roll back anyway: systemctl start learnharness-rollback-force; nothing was changed")
                return EXIT_FAILED
            self.log(f"forced rollback although third-party images differ ({listed})")
        missing = sorted(set(then.values()) - have)
        if missing:
            self.log(f"rollback: {', '.join(missing)} not on this machine (a rollback never pulls); "
                     "nothing was changed")
            return EXIT_FAILED
        self.log(f"rolling back from {describe(cur)} to {describe(prev)}")
        self.format_note(prev, cur)
        try:
            self.bring_up(prev, pull_never=True)
        except Failed as e:
            self.log(f"rollback to {describe(prev)} failed ({e}); bringing {describe(cur)} back")
            try:
                self.bring_up(cur, pull_never=True)
            except Failed as e2:
                self.log(f"bringing {describe(cur)} back failed too ({e2}): check docker compose ps")
            return EXIT_FAILED
        try:
            self.save(after_rollback(state))
        except OSError as e:
            self.log(f"rolled back to {describe(prev)} but the deploy state could not be written ({e}); "
                     f"a restart would start {describe(cur)} again")
            return EXIT_FAILED
        if not self.wait_healthy(prev["tag"]):
            self.log(f"rolled back to {describe(prev)}, but the app did not report healthy within "
                     f"{self.health_timeout}s")
            return EXIT_FAILED
        self.bootstrap_keycloak()
        self.log(f"rolled back to {describe(prev)}")
        return 0

    def prune(self, command):
        """Run `command` while stopped containers hold the images of the current and
        previous deploy (ours and the third-party ones). If any cannot be held,
        nothing is pruned."""
        state, err = self.read_state()
        if err:
            self.log(f"prune skipped: {err}")
            return EXIT_RETRY
        self.drop_keepers()
        try:
            have = self.images()
            hold = set()
            for r in (state["current"], state["previous"], state["pending"]) if state else ():
                if r:
                    hold |= images_of(r["tag"])
                    try:
                        hold |= set(third_party_images(self.compose_at(r["commit"])).values())
                    except Failed as e:
                        self.log(f"the third-party images of {describe(r)} are not known ({e}); holding ours only")
            for i, ref in enumerate(sorted(hold & have)):
                name = f"{KEEPER_PREFIX}{i}-" + re.sub(r"[^A-Za-z0-9_.-]", "-", ref)
                if self.run(["docker", "create", "--pull", "never", "--network", "none", "--name", name, ref],
                            capture=True, timeout=T_INSPECT)[0] != 0:
                    self.log(f"prune skipped: could not hold {ref}")
                    return EXIT_RETRY
            return self.run(command)[0]
        except Failed as e:
            self.log(f"prune skipped: {e}")
            return EXIT_RETRY
        finally:
            self.drop_keepers()

    def drop_keepers(self):
        code, out = self.run(["docker", "ps", "-a", "--format", "{{.Names}}"], capture=True, timeout=T_INSPECT)
        for name in out.split() if code == 0 else []:
            if name.startswith(KEEPER_PREFIX):
                self.run(["docker", "rm", "-f", "-v", name], capture=True, timeout=T_INSPECT)


def parse_args(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--src", required=True, help="the git checkout")
    ap.add_argument("--state", required=True, help="the deploy state file")
    ap.add_argument("--hosts-env", required=True)
    ap.add_argument("--secrets", required=True)
    ap.add_argument("--keycloak-bootstrap", required=True)
    ap.add_argument("--health-timeout", type=int, default=300, help="seconds to wait for a healthy app")
    sub = ap.add_subparsers(dest="cmd", required=True)
    st = sub.add_parser("start")
    st.add_argument("--default-target", required=True)
    dp = sub.add_parser("deploy")
    dp.add_argument("target")
    rb = sub.add_parser("rollback")
    rb.add_argument("--force", action="store_true", help="even when third-party images differ")
    pr = sub.add_parser("prune")
    pr.add_argument("command", nargs=argparse.REMAINDER)
    a = ap.parse_args(argv)
    if a.cmd == "prune":
        a.command = a.command[1:] if a.command[:1] == ["--"] else a.command
        if not a.command:
            ap.error("prune needs a command after --")
    return a


def main(argv=None):
    a = parse_args(argv)
    stack = Stack(a.src, a.state, a.hosts_env, a.secrets, a.keycloak_bootstrap, health_timeout=a.health_timeout)
    if a.cmd == "start":
        return stack.start(a.default_target)
    if a.cmd == "deploy":
        return stack.deploy(a.target)
    if a.cmd == "rollback":
        return stack.rollback(force=a.force)
    return stack.prune(a.command)


if __name__ == "__main__":
    sys.exit(main())

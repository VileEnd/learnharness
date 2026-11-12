"""deploy/nixos/deploy.py: which target, which state, start/deploy/rollback, what to prune.

The flow tests drive the script against `World`, a small in-memory stand-in for
git and docker that answers exactly the commands the script runs. One test runs
the real `git fetch` against a local bare repository (no network)."""

import importlib.util
import json
import os
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "deploy" / "nixos" / "deploy.py"


def load():
    spec = importlib.util.spec_from_file_location("deploy", SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


D = load()
REPOS = ("learnharness", "learnharness-caddy", "learnharness-ocr", "learnharness-claude")
TAGGED = (ROOT / "deploy" / "compose.yaml").read_text()
UNTAGGED = "services:\n  learnharness:\n    build: ..\n    image: learnharness:local\n"
THIRD = D.third_party_images(TAGGED)  # service -> image, from the repo's compose file
OLD_PG = TAGGED.replace(f"image: {THIRD['keycloak-db']}", "image: postgres:16.9-alpine")


def sha(n):
    return f"{n:x}" * 40 if n < 16 else f"{n:040x}"


def rec(n, target=None, tag=None):
    return {"target": target or f"v0.{n}.0", "commit": sha(n), "tag": tag or sha(n)[:12], "time": "2026-11-12T10:00:00Z"}


def ours(images):
    return sorted({i.split(":")[1] for i in images if i.split(":")[0] in REPOS})


def state(current, previous=None, pending=None):
    return {"version": 1, "current": current, "previous": previous, "pending": pending}


class World:
    """git and docker, just enough for Stack: origin, local refs, a checkout, images, containers."""

    def __init__(self):
        self.origin = {}  # "refs/heads/main" | "refs/tags/v0.1.0" -> commit
        self.refs = {}  # local: "refs/tags/…", "refs/remotes/origin/…", "refs/learnharness/…"
        self.objects = set()  # commits present in the checkout
        self.head = None
        self.compose = {}  # commit -> compose.yaml text (default: the repo's)
        self.images = {img: f"id-{img}" for img in THIRD.values()}  # "repo:tag" -> image id
        self.containers = {}  # name -> (image ref, image id)
        self.broken = set()  # commits whose build fails
        self.unhealthy = set()  # image tags whose app never becomes healthy
        self.up_fails = set()  # image tags whose `up` fails
        self.create_fails = set()  # image refs `docker create` refuses
        self.fetch_fails = False
        self.docker_down = False
        self.calls = []
        self.t = 0.0

    def tag(self, name, commit):
        self.origin[f"refs/tags/{name}"] = commit

    def branch(self, name, commit):
        self.origin[f"refs/heads/{name}"] = commit

    def build(self, tag, commit):
        self.objects.add(commit)
        for repo in REPOS:
            self.images[f"{repo}:{tag}"] = f"id-{commit[:6]}-{repo}"

    def run_on(self, tag):
        for svc, repo in D.SERVICES.items():
            ref = f"{repo}:{tag}"
            self.containers[f"learnharness-{svc}-1"] = (ref, self.images[ref])

    def app(self):
        return self.containers.get("learnharness-learnharness-1", ("",))[0]

    def did(self, *words):
        return [c for c in self.calls if all(w in c for w in words)]

    def builds(self):
        return [c for c in self.calls if c[:2] == ["docker", "compose"] and c[-1] == "build"]

    def __call__(self, argv, capture=False, cwd=None, env=None, timeout=None):
        self.calls.append(list(argv))
        tag = (env or {}).get("LH_IMAGE_TAG")
        if argv[0] == "docker" and self.docker_down:
            return 1, ""
        match argv:
            case ["git", "-C", _, "rev-parse", "--verify", "--quiet", ref]:
                ref = ref.removesuffix("^{commit}")
                commit = self.head if ref == "HEAD" else self.refs.get(ref)
                return (0, commit + "\n") if commit else (1, "")
            case ["git", "-C", _, "cat-file", "-e", spec]:
                return (0, "") if spec.removesuffix("^{commit}") in self.objects else (1, "")
            case ["git", "-C", _, "fetch", *flags]:
                if self.fetch_fails:
                    return 128, ""
                assert flags == ["--prune", "--prune-tags", "--force", "--tags", "origin"], flags
                for r in [r for r in self.refs if r.startswith(("refs/remotes/origin/", "refs/tags/"))]:
                    del self.refs[r]
                for r, c in self.origin.items():
                    self.refs[r.replace("refs/heads/", "refs/remotes/origin/")] = c
                    self.objects.add(c)
                return 0, ""
            case ["git", "-C", _, "for-each-ref", "--format=%(refname)", prefix]:
                return 0, "".join(r + "\n" for r in self.refs if r.startswith(prefix))
            case ["git", "-C", _, "show", spec]:
                commit = spec.split(":")[0]
                return (0, self.compose.get(commit, TAGGED)) if commit in self.objects else (128, "")
            case ["git", "-C", _, "checkout", "--quiet", "--force", "--detach", commit]:
                if commit not in self.objects:
                    return 128, ""
                self.head = commit
                return 0, ""
            case ["git", "-C", _, "update-ref", "-d", ref]:
                self.refs.pop(ref, None)
                return 0, ""
            case ["git", "-C", _, "update-ref", ref, commit]:
                self.refs[ref] = commit
                return 0, ""
            case ["docker", "compose", "--env-file", _, "--env-file", _, "build"]:
                if self.head in self.broken:
                    return 1, ""
                self.build(tag, self.head)
                return 0, ""
            case ["docker", "compose", "--env-file", _, "--env-file", _, "up", "-d", "--no-build", *opts]:
                needed = {f"{repo}:{tag}" for repo in REPOS}
                if "never" in opts:  # --pull never: third-party images must be here already
                    needed |= set(D.third_party_images(self.compose.get(self.head, TAGGED)).values())
                if tag in self.up_fails or not needed <= set(self.images):
                    return 1, ""
                self.run_on(tag)
                return 0, ""
            case ["docker", "compose", "--env-file", _, "--env-file", _, "exec", "-T", "caddy", *_] | ["timeout", *_]:
                return 0, ""
            case ["docker", "image", "ls", "--format", _]:
                return 0, "".join(i + "\n" for i in self.images)
            case ["docker", "image", "inspect", "--format", _, ref]:
                return (0, self.images[ref] + "\n") if ref in self.images else (1, "")
            case ["docker", "image", "rm", ref]:
                self.images.pop(ref)
                return 0, ""
            case ["docker", "inspect", "--format", fmt, name]:
                if name not in self.containers:
                    return 1, ""
                ref, image_id = self.containers[name]
                if "Health" not in fmt:
                    return 0, image_id + "\n"
                return 0, f"{ref} {'unhealthy' if ref.split(':')[1] in self.unhealthy else 'healthy'}\n"
            case ["docker", "create", "--pull", "never", "--network", "none", "--name", name, ref]:
                if ref in self.create_fails:
                    return 1, ""
                self.containers[name] = (ref, self.images[ref])
                return 0, ""
            case ["docker", "ps", "-a", "--format", _]:
                return 0, "".join(n + "\n" for n in self.containers)
            case ["docker", "rm", "-f", "-v", name]:
                del self.containers[name]
                return 0, ""
            case ["docker", "system", "prune", *_]:
                used = {i for _, i in self.containers.values()}
                self.images = {r: i for r, i in self.images.items() if i in used}
                return 0, ""
        raise AssertionError(f"unexpected command: {argv}")

    def sleep(self, s):
        self.t += s


class Run:
    """A Stack on a World with a state file in a temp dir; the log lines are kept."""

    def __init__(self, test, world):
        d = tempfile.TemporaryDirectory()
        test.addCleanup(d.cleanup)
        self.state_path = os.path.join(d.name, "deploy-state.json")
        self.lines = []
        self.world = world
        self.stack = D.Stack(
            src=os.path.join(d.name, "src"), state=self.state_path, hosts_env="/h.env", secrets="/s.env",
            keycloak_bootstrap="/bootstrap.sh", run=world, sleep=world.sleep, monotonic=lambda: world.t,
            now=lambda: "2026-11-12T12:00:00Z", log=self.lines.append, health_timeout=300,
        )

    def state(self):
        return D.read_state(self.state_path)

    def save(self, current, previous=None, pending=None):
        for r in (current, previous, pending):
            if r:
                self.world.objects.add(r["commit"])
        D.write_state(self.state_path, state(current, previous, pending))

    def deployed(self, n, previous=None):
        """World and state as after a successful deploy of commit n."""
        self.world.build(sha(n)[:12], sha(n))
        self.world.run_on(sha(n)[:12])
        self.world.head = sha(n)
        self.save(rec(n), previous)

    def log(self):
        return "\n".join(self.lines)


# --- decisions ---------------------------------------------------------------

class NewestRelease(unittest.TestCase):
    def test_version_order_not_string_order(self):
        self.assertEqual(D.newest_release(["v0.9.0", "v0.10.0", "v0.2.11"]), "v0.10.0")

    def test_only_release_tags_count(self):
        self.assertEqual(D.newest_release(["v1.0.0", "v2.0.0-rc1", "v3.0", "release", "v1.0.1"]), "v1.0.1")
        self.assertIsNone(D.newest_release(["v2.0.0-rc1", "nightly"]))


class ResolveTarget(unittest.TestCase):
    TAGS = {"v0.9.0", "v0.10.0"}
    BRANCHES = {"main", "ops/x"}

    def test_latest_named_tag_and_branch(self):
        self.assertEqual(D.resolve_target("latest", self.TAGS, self.BRANCHES), ("v0.10.0", "refs/tags/v0.10.0"))
        self.assertEqual(D.resolve_target("v0.9.0", self.TAGS, self.BRANCHES), ("v0.9.0", "refs/tags/v0.9.0"))
        self.assertEqual(D.resolve_target("main", self.TAGS, self.BRANCHES), ("main", "refs/remotes/origin/main"))
        self.assertEqual(D.resolve_target("ops/x", self.TAGS, self.BRANCHES), ("ops/x", "refs/remotes/origin/ops/x"))

    def test_unknown_or_malformed_targets_are_refused(self):
        for t in ["v0.11.0", "dev", "", "-c", "-h", "a..b", "x.lock", "main/", "a b", "latest"]:
            tags = self.TAGS if t != "latest" else set()
            with self.subTest(t=t), self.assertRaises(D.Refused):
                D.resolve_target(t, tags, self.BRANCHES)


class Arguments(unittest.TestCase):
    COMMON = ["--src", "s", "--state", "f", "--hosts-env", "h", "--secrets", "x", "--keycloak-bootstrap", "b"]

    def test_a_target_that_looks_like_an_option_stays_a_target(self):
        self.assertEqual(D.parse_args([*self.COMMON, "deploy", "--", "-h"]).target, "-h")

    def test_forced_rollback_has_its_own_spelling(self):
        self.assertFalse(D.parse_args([*self.COMMON, "rollback"]).force)
        self.assertTrue(D.parse_args([*self.COMMON, "rollback", "--force"]).force)


class Compose(unittest.TestCase):
    def test_the_repo_compose_file_takes_the_tag_from_the_environment(self):
        self.assertTrue(D.supports_tagged_images(TAGGED))

    def test_a_compose_file_with_fixed_local_images_does_not(self):
        self.assertFalse(D.supports_tagged_images(UNTAGGED))

    def test_third_party_images_are_every_image_but_our_own(self):
        self.assertEqual(sorted(THIRD), ["keycloak", "keycloak-db", "oauth2-proxy"])
        self.assertEqual(D.third_party_images(UNTAGGED), {})
        self.assertEqual(D.image_differences(THIRD, THIRD), [])
        self.assertEqual(D.image_differences(THIRD, D.third_party_images(OLD_PG)),
                         [("keycloak-db", THIRD["keycloak-db"], "postgres:16.9-alpine")])


class State(unittest.TestCase):
    def test_missing_is_none_and_a_write_reads_back(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "deploy-state.json")
            self.assertIsNone(D.read_state(p))
            s = state(rec(2), rec(1), rec(3))
            D.write_state(p, s)
            self.assertEqual(D.read_state(p), s)
            self.assertEqual(os.listdir(d), ["deploy-state.json"])  # no temp file left behind
            self.assertEqual(stat.S_IMODE(os.stat(p).st_mode), 0o644)

    def test_unreadable_states_are_refused(self):
        bad = [
            "{not json",
            json.dumps({"version": 2, "current": rec(1), "previous": None}),  # newer build wrote it
            json.dumps({"version": 1, "current": {**rec(1), "tag": "../x"}, "previous": None}),
            json.dumps({"version": 1, "current": None, "previous": None}),
            json.dumps({"version": 1, "current": rec(1), "previous": None, "pending": "x"}),
        ]
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "deploy-state.json")
            for text in bad:
                Path(p).write_text(text)
                with self.subTest(text=text), self.assertRaises(D.Refused):
                    D.read_state(p)

    def test_a_deploy_moves_current_to_previous_unless_it_is_the_same_commit(self):
        s = state(rec(2), rec(1), rec(3))
        self.assertEqual(D.after_deploy(s, rec(2), rec(3)), state(rec(3), rec(2)))
        again = rec(2, target="main")
        self.assertEqual(D.after_deploy(s, rec(2), again), state(again, rec(1)))
        legacy = rec(1, target="legacy", tag="local")
        self.assertEqual(D.after_deploy(None, legacy, rec(3)), state(rec(3), legacy))
        self.assertEqual(D.after_deploy(None, None, rec(3)), state(rec(3)))

    def test_rolling_back_twice_returns_to_where_you_were(self):
        s = state(rec(2), rec(1))
        self.assertEqual(D.after_rollback(s), state(rec(1), rec(2)))
        self.assertEqual(D.after_rollback(D.after_rollback(s)), s)


class PlanStart(unittest.TestCase):
    def images(self, tag):
        return {f"{r}:{tag}" for r in REPOS}

    def test_choices(self):
        s = state(rec(2), rec(1))
        self.assertEqual(D.plan_start(s, self.images(sha(2)[:12])), ("up", rec(2)))
        self.assertEqual(D.plan_start(None, self.images("local") | {"postgres:17"}), ("legacy", None))
        self.assertEqual(D.plan_start(None, {"postgres:17", "learnharness-ocr:debug"}), ("deploy", None))
        self.assertEqual(D.plan_start(None, set()), ("deploy", None))

    def test_refusals_never_build(self):
        s = state(rec(2), rec(1))
        self.assertEqual(D.plan_start(s, self.images(sha(1)[:12]))[0], "refuse")  # current images gone
        self.assertEqual(D.plan_start(None, self.images(sha(2)[:12]))[0], "refuse")  # images but no state


class StaleImages(unittest.TestCase):
    def test_only_our_deploy_tags_older_than_previous(self):
        listing = [f"{r}:{t}" for r in REPOS for t in (sha(1)[:12], sha(2)[:12], sha(3)[:12], "local")]
        listing += ["learnharness:debug", "postgres:17.11-alpine", "<none>:<none>"]
        stale = D.stale_images(listing, {sha(3)[:12], sha(2)[:12]})
        self.assertEqual(sorted(stale), sorted(f"{r}:{t}" for r in REPOS for t in (sha(1)[:12], "local")))


class LegacyRecord(unittest.TestCase):
    def test_recorded_only_when_the_running_stack_is_the_local_images(self):
        ids = {svc: f"id-{svc}" for svc in D.SERVICES}
        self.assertEqual(D.legacy_record(sha(7), ids, dict(ids), "T"),
                         {"target": "legacy", "commit": sha(7), "tag": "local", "time": "T"})
        self.assertIsNone(D.legacy_record(sha(7), ids, {**ids, "learnharness": "id-other"}, "T"))
        self.assertIsNone(D.legacy_record(sha(7), {**ids, "ocr": None}, {**ids, "ocr": None}, "T"))
        self.assertIsNone(D.legacy_record(None, ids, dict(ids), "T"))


class Fetch(unittest.TestCase):
    """The real git: tags deleted on origin go, the commits the state pins stay."""

    def git(self, *args, cwd):
        subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "init.defaultBranch=main",
                        *args], cwd=cwd, check=True, capture_output=True)

    def test_tags_deleted_on_origin_disappear_and_the_pins_stay(self):
        with tempfile.TemporaryDirectory() as d:
            work, origin, src = (os.path.join(d, n) for n in ("work", "origin.git", "src"))
            self.git("init", "-q", work, cwd=d)
            self.git("commit", "-q", "--allow-empty", "-m", "one", cwd=work)
            self.git("tag", "v0.1.0", cwd=work)
            self.git("commit", "-q", "--allow-empty", "-m", "two", cwd=work)
            self.git("tag", "v0.9.0", cwd=work)
            self.git("clone", "-q", "--bare", work, origin, cwd=d)
            self.git("clone", "-q", origin, src, cwd=d)
            pinned = subprocess.run(["git", "-C", src, "rev-parse", "v0.9.0"], capture_output=True, text=True).stdout.strip()
            self.git("update-ref", "refs/learnharness/current", pinned, cwd=src)
            self.git("tag", "-d", "v0.9.0", cwd=origin)  # withdrawn on origin, and main rewound
            self.git("update-ref", "refs/heads/main", "v0.1.0", cwd=origin)

            stack = D.Stack(src=src, state=os.path.join(d, "s.json"), hosts_env="h", secrets="s",
                            keycloak_bootstrap="b", log=lambda m: None)
            stack.fetch()
            tags = subprocess.run(["git", "-C", src, "tag"], capture_output=True, text=True).stdout.split()
            self.assertEqual(tags, ["v0.1.0"])
            kept = subprocess.run(["git", "-C", src, "rev-parse", "refs/learnharness/current"],
                                  capture_output=True, text=True).stdout.strip()
            self.assertEqual(kept, pinned)
            self.assertEqual(subprocess.run(["git", "-C", src, "cat-file", "-e", pinned + "^{commit}"]).returncode, 0)


# --- flows -------------------------------------------------------------------

class Deploy(unittest.TestCase):
    def test_success_records_previous_and_removes_older_images(self):
        w = World()
        r = Run(self, w)
        w.build(sha(1)[:12], sha(1))
        r.deployed(2, previous=rec(1))
        w.tag("v0.2.0", sha(2))
        w.tag("v0.10.0", sha(3))
        self.assertEqual(r.stack.deploy("latest"), 0)
        self.assertEqual(r.state(), state({**rec(3, target="v0.10.0"), "time": "2026-11-12T12:00:00Z"}, rec(2)))
        self.assertEqual(w.app(), f"learnharness:{sha(3)[:12]}")
        self.assertEqual(ours(w.images), sorted([sha(2)[:12], sha(3)[:12]]))
        # Both commits stay in the checkout even if their branch or tag is deleted on origin.
        self.assertEqual((w.refs["refs/learnharness/current"], w.refs["refs/learnharness/previous"]), (sha(3), sha(2)))
        # The Keycloak bootstrap runs once, after the app is healthy.
        self.assertEqual(len(w.did("timeout")), 1)
        last_health = max(i for i, c in enumerate(w.calls) if "learnharness-learnharness-1" in c)
        self.assertGreater(w.calls.index(w.did("timeout")[0]), last_health)

    def test_a_fetch_failure_changes_nothing_and_may_be_retried(self):
        w = World()
        r = Run(self, w)
        r.deployed(2)
        w.fetch_fails = True
        self.assertEqual(r.stack.deploy("latest"), D.EXIT_RETRY)
        self.assertEqual((w.head, r.state()), (sha(2), state(rec(2))))
        self.assertEqual(w.builds(), [])

    def test_a_target_that_looks_like_an_option_is_refused_before_anything_runs(self):
        w = World()
        r = Run(self, w)
        self.assertEqual(r.stack.deploy("-h"), D.EXIT_FAILED)
        self.assertEqual(w.calls, [])

    def test_a_failed_build_leaves_the_running_stack_and_the_checkout(self):
        w = World()
        r = Run(self, w)
        r.deployed(2, previous=rec(1))
        w.branch("main", sha(3))
        w.broken.add(sha(3))
        running = dict(w.containers)
        self.assertEqual(r.stack.deploy("main"), D.EXIT_FAILED)
        self.assertEqual(w.containers, running)
        self.assertFalse(w.did("up"))
        self.assertEqual(w.head, sha(2))
        self.assertEqual(r.state(), state(rec(2), rec(1)))
        self.assertIn("build failed", r.lines[-1])

    def test_an_unhealthy_deploy_goes_back_by_itself(self):
        w = World()
        r = Run(self, w)
        r.deployed(2, previous=rec(1))
        w.tag("v0.3.0", sha(3))
        w.unhealthy.add(sha(3)[:12])
        self.assertEqual(r.stack.deploy("v0.3.0"), D.EXIT_FAILED)
        self.assertEqual((w.app(), w.head), (f"learnharness:{sha(2)[:12]}", sha(2)))
        self.assertEqual(r.state(), state(rec(2), rec(1)))
        self.assertIn("not healthy", r.lines[-1])
        self.assertIn("back on v0.2.0", r.lines[-1])
        self.assertIn("cannot read records", r.log())  # the data-format warning names both commits
        self.assertIn(f"{sha(2)[:12]}..{sha(3)[:12]}", r.log())
        self.assertEqual(w.did("timeout"), [])  # no Keycloak bootstrap for a release that never got healthy
        self.assertEqual(w.did("up")[-1][-2:], ["--pull", "never"])  # the go-back never reaches for the network

    def test_a_failed_up_goes_back_too(self):
        w = World()
        r = Run(self, w)
        r.deployed(2, previous=rec(1))
        w.tag("v0.3.0", sha(3))
        w.up_fails.add(sha(3)[:12])
        self.assertEqual(r.stack.deploy("v0.3.0"), D.EXIT_FAILED)
        self.assertEqual(w.app(), f"learnharness:{sha(2)[:12]}")
        self.assertEqual(r.state(), state(rec(2), rec(1)))
        self.assertIn("starting it failed", r.lines[-1])

    def test_unhealthy_with_nothing_to_go_back_to_stays_up_and_is_recorded(self):
        w = World()
        r = Run(self, w)
        w.tag("v0.1.0", sha(1))
        w.unhealthy.add(sha(1)[:12])
        self.assertEqual(r.stack.deploy("latest"), D.EXIT_FAILED)
        self.assertEqual(w.app(), f"learnharness:{sha(1)[:12]}")
        self.assertEqual(r.state()["current"]["commit"], sha(1))
        self.assertIn("stays up", r.lines[-1])

    def test_unhealthy_redeploy_of_the_running_build_says_there_is_nothing_else(self):
        w = World()
        r = Run(self, w)
        r.deployed(2, previous=rec(1))
        w.branch("main", sha(2))
        w.unhealthy.add(sha(2)[:12])
        self.assertEqual(r.stack.deploy("main"), D.EXIT_FAILED)
        self.assertIn("same build", r.lines[-1])
        self.assertEqual(r.state(), state(rec(2), rec(1)))

    def test_a_target_already_running_and_healthy_is_left_alone(self):
        w = World()
        r = Run(self, w)
        r.deployed(2, previous=rec(1))
        w.tag("v0.2.0", sha(2))
        self.assertEqual(r.stack.deploy("v0.2.0"), 0)
        self.assertIn(f"already running {sha(2)[:12]}", r.lines[-1])
        self.assertEqual((w.builds(), w.did("up")), ([], []))
        self.assertEqual(r.state(), state(rec(2), rec(1)))

    def test_a_failed_final_state_write_leaves_the_pending_marker_for_the_next_start(self):
        w = World()
        r = Run(self, w)
        r.deployed(2, previous=rec(1))
        w.tag("v0.3.0", sha(3))
        writes = []

        def write_once(path, s):
            if writes:
                raise OSError(28, "No space left on device")
            writes.append(s)
            D.write_state(path, s)

        r.stack.write_state = write_once
        self.assertEqual(r.stack.deploy("v0.3.0"), D.EXIT_FAILED)
        self.assertIn("could not be written", r.lines[-1])
        self.assertEqual(r.state()["pending"]["commit"], sha(3))  # written before `up`
        self.assertEqual(r.state()["current"], rec(2))

        r.stack.write_state = D.write_state
        self.assertEqual(r.stack.start("latest"), 0)
        self.assertIn(f"a deploy of v0.3.0 ({sha(3)[:12]}) was interrupted; starting the recorded v0.2.0", r.log())
        self.assertEqual(r.state(), state(rec(2), rec(1)))
        self.assertEqual(w.app(), f"learnharness:{sha(2)[:12]}")

    def test_a_target_from_before_tagged_images_is_refused_before_anything_moves(self):
        w = World()
        r = Run(self, w)
        r.deployed(2)
        w.tag("v0.1.0", sha(1))
        w.compose[sha(1)] = UNTAGGED
        self.assertEqual(r.stack.deploy("v0.1.0"), D.EXIT_FAILED)
        self.assertEqual(w.head, sha(2))
        self.assertEqual(w.builds(), [])

    def test_the_first_deploy_keeps_the_running_local_stack_as_previous(self):
        w = World()
        r = Run(self, w)
        w.build("local", sha(1))
        w.run_on("local")
        w.head = sha(1)
        w.branch("main", sha(2))
        self.assertEqual(r.stack.deploy("main"), 0)
        self.assertEqual(r.state()["previous"], {"target": "legacy", "commit": sha(1), "tag": "local",
                                                 "time": "2026-11-12T12:00:00Z"})
        self.assertIn("learnharness:local", w.images)  # kept: it is the rollback target
        self.assertEqual(r.stack.rollback(), 0)
        self.assertEqual((w.app(), w.head), ("learnharness:local", sha(1)))


class Rollback(unittest.TestCase):
    def test_twice_returns_and_never_builds_or_fetches(self):
        w = World()
        r = Run(self, w)
        w.build(sha(1)[:12], sha(1))
        r.deployed(2, previous=rec(1))
        self.assertEqual(r.stack.rollback(), 0)
        self.assertEqual((w.head, w.containers["learnharness-ocr-1"][0]), (sha(1), f"learnharness-ocr:{sha(1)[:12]}"))
        self.assertIn("cannot read records", r.log())
        self.assertEqual(r.stack.rollback(), 0)
        self.assertEqual((w.head, w.containers["learnharness-ocr-1"][0]), (sha(2), f"learnharness-ocr:{sha(2)[:12]}"))
        self.assertEqual(r.state(), state(rec(2), rec(1)))
        self.assertEqual((w.builds(), w.did("fetch")), ([], []))
        self.assertTrue(all(c[-2:] == ["--pull", "never"] for c in w.did("up")))

    def test_refused_without_a_previous_deploy_or_its_images(self):
        w = World()
        r = Run(self, w)
        r.deployed(2)
        self.assertEqual(r.stack.rollback(), D.EXIT_FAILED)
        self.assertIn("no previous deploy", r.lines[-1])
        r.save(rec(2), rec(1))  # recorded, but its images are gone
        self.assertEqual(r.stack.rollback(), D.EXIT_FAILED)
        self.assertEqual((w.head, r.state()["current"]), (sha(2), rec(2)))

    def test_a_changed_third_party_image_is_refused_unless_forced(self):
        w = World()
        r = Run(self, w)
        w.build(sha(1)[:12], sha(1))
        w.compose[sha(1)] = OLD_PG
        w.images["postgres:16.9-alpine"] = "id-pg16"
        r.deployed(2, previous=rec(1))
        self.assertEqual(r.stack.rollback(), D.EXIT_FAILED)
        self.assertIn(f"keycloak-db: {THIRD['keycloak-db']} now, postgres:16.9-alpine", r.lines[-1])
        self.assertIn("learnharness-rollback-force", r.lines[-1])
        self.assertEqual((w.head, w.did("up")), (sha(2), []))
        self.assertEqual(r.stack.rollback(force=True), 0)
        self.assertEqual((w.head, w.app()), (sha(1), f"learnharness:{sha(1)[:12]}"))

    def test_a_failed_up_brings_the_current_deploy_back(self):
        w = World()
        r = Run(self, w)
        w.build(sha(1)[:12], sha(1))
        r.deployed(2, previous=rec(1))
        w.up_fails.add(sha(1)[:12])
        self.assertEqual(r.stack.rollback(), D.EXIT_FAILED)
        self.assertEqual((w.head, w.app()), (sha(2), f"learnharness:{sha(2)[:12]}"))
        self.assertEqual(r.state(), state(rec(2), rec(1)))


class Start(unittest.TestCase):
    def test_boot_starts_the_current_deploy_without_fetching_or_building(self):
        w = World()
        r = Run(self, w)
        r.deployed(2)
        w.head = sha(9)  # an interrupted deploy had moved the checkout
        w.containers.clear()
        self.assertEqual(r.stack.start("latest"), 0)
        self.assertEqual(w.head, sha(2))
        self.assertEqual(w.containers["learnharness-caddy-1"][0], f"learnharness-caddy:{sha(2)[:12]}")
        self.assertEqual((w.did("fetch"), w.builds()), ([], []))

    def test_without_state_the_local_stack_starts_as_it_is(self):
        w = World()
        r = Run(self, w)
        w.build("local", sha(1))
        w.head = sha(1)
        self.assertEqual(r.stack.start("latest"), 0)
        self.assertEqual(w.app(), "learnharness:local")
        self.assertIsNone(r.state())
        self.assertEqual((w.did("fetch"), w.did("checkout"), w.builds()), ([], [], []))

    def test_a_fresh_machine_deploys_the_default_target(self):
        w = World()
        r = Run(self, w)
        w.tag("v0.1.0", sha(1))
        self.assertEqual(r.stack.start("latest"), 0)
        self.assertEqual(r.state()["current"]["target"], "v0.1.0")

    def test_docker_not_ready_is_retried(self):
        w = World()
        r = Run(self, w)
        r.deployed(2)
        w.docker_down = True
        self.assertEqual(r.stack.start("latest"), D.EXIT_RETRY)

    def test_a_recorded_commit_missing_from_the_checkout_is_not_retried(self):
        w = World()
        r = Run(self, w)
        w.build(sha(5)[:12], sha(5))
        w.objects.discard(sha(5))
        D.write_state(r.state_path, state(rec(5)))
        self.assertEqual(r.stack.start("latest"), D.EXIT_FAILED)
        self.assertIn(f"{sha(5)[:12]} is not in the checkout", r.lines[-1])

    def test_an_unreadable_state_is_not_overwritten_or_guessed_around(self):
        w = World()
        r = Run(self, w)
        Path(r.state_path).write_text("{")
        self.assertEqual(r.stack.start("latest"), D.EXIT_FAILED)
        self.assertEqual(r.stack.deploy("main"), D.EXIT_FAILED)
        self.assertEqual(r.stack.rollback(), D.EXIT_FAILED)
        self.assertEqual(Path(r.state_path).read_text(), "{")
        self.assertEqual(w.calls, [])


class Prune(unittest.TestCase):
    PRUNE = ["docker", "system", "prune", "-f", "--all"]

    def test_the_weekly_prune_keeps_current_and_previous_with_their_third_party_images(self):
        w = World()
        r = Run(self, w)
        w.build(sha(1)[:12], sha(1))
        w.compose[sha(1)] = OLD_PG
        w.images["postgres:16.9-alpine"] = "id-pg16"  # only the previous deploy uses it
        w.build(sha(0xA)[:12], sha(0xA))  # an older deploy nothing refers to
        r.deployed(2, previous=rec(1))
        self.assertEqual(r.stack.prune(self.PRUNE), 0)
        self.assertEqual(ours(w.images), sorted([sha(1)[:12], sha(2)[:12]]))
        self.assertIn("postgres:16.9-alpine", w.images)
        self.assertFalse([n for n in w.containers if n.startswith("learnharness-keep-")])

    def test_a_keeper_that_cannot_be_created_skips_the_prune(self):
        w = World()
        r = Run(self, w)
        w.build(sha(1)[:12], sha(1))
        r.deployed(2, previous=rec(1))
        w.create_fails.add(f"learnharness-ocr:{sha(1)[:12]}")
        before = dict(w.images)
        self.assertNotEqual(r.stack.prune(self.PRUNE), 0)
        self.assertEqual((w.images, w.did("system", "prune")), (before, []))
        self.assertFalse([n for n in w.containers if n.startswith("learnharness-keep-")])
        self.assertIn("prune skipped", r.lines[-1])

    def test_an_unreadable_state_skips_the_prune(self):
        w = World()
        r = Run(self, w)
        Path(r.state_path).write_text("{")
        self.assertNotEqual(r.stack.prune(self.PRUNE), 0)
        self.assertEqual(w.did("system", "prune"), [])


if __name__ == "__main__":
    unittest.main()

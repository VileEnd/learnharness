"""deploy/nixos/deploy.py: which target, which state, start/deploy/rollback, what to prune.

The flow tests drive the script against `World`, a small in-memory stand-in for
git and docker that answers exactly the commands the script runs."""

import importlib.util
import json
import os
import stat
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


def sha(n):
    return f"{n:x}" * 40 if n < 16 else f"{n:040x}"


def rec(n, target=None, tag=None):
    return {"target": target or f"v0.{n}.0", "commit": sha(n), "tag": tag or sha(n)[:12], "time": "2026-11-12T10:00:00Z"}


class World:
    """git and docker, just enough for Stack: refs, a checkout, images, containers."""

    def __init__(self):
        self.refs = {}  # "refs/tags/v0.1.0" | "refs/remotes/origin/main" -> commit
        self.head = None
        self.compose = {}  # commit -> compose.yaml text (default: the tagged one)
        self.images = {}  # "repo:tag" -> image id
        self.containers = {}  # name -> (image ref, image id)
        self.broken = set()  # commits whose build fails
        self.unhealthy = set()  # image tags whose app never becomes healthy
        self.calls = []
        self.t = 0.0

    def tag(self, name, commit):
        self.refs[f"refs/tags/{name}"] = commit

    def build(self, tag, commit):
        for repo in REPOS:
            self.images[f"{repo}:{tag}"] = f"id-{commit[:6]}-{repo}"

    def run_on(self, tag):
        for svc, repo in D.SERVICES.items():
            ref = f"{repo}:{tag}"
            self.containers[f"learnharness-{svc}-1"] = (ref, self.images[ref])

    def builds(self):
        return [c for c in self.calls if c[:2] == ["docker", "compose"] and c[-1] == "build"]

    def __call__(self, argv, capture=False, cwd=None, env=None):
        self.calls.append(list(argv))
        tag = (env or {}).get("LH_IMAGE_TAG")
        match argv:
            case ["git", "-C", _, "rev-parse", "--verify", "--quiet", ref]:
                ref = ref.removesuffix("^{commit}")
                commit = self.head if ref == "HEAD" else self.refs.get(ref)
                return (0, commit + "\n") if commit else (1, "")
            case ["git", "-C", _, "fetch", *_]:
                return 0, ""
            case ["git", "-C", _, "for-each-ref", "--format=%(refname)", prefix]:
                return 0, "".join(r + "\n" for r in self.refs if r.startswith(prefix))
            case ["git", "-C", _, "show", spec]:
                return 0, self.compose.get(spec.split(":")[0], TAGGED)
            case ["git", "-C", _, "checkout", "--quiet", "--force", "--detach", commit]:
                self.head = commit
                return 0, ""
            case ["git", "-C", _, "update-ref", ref, commit]:
                self.refs[ref] = commit
                return 0, ""
            case ["git", "-C", _, "update-ref", "-d", ref]:
                self.refs.pop(ref, None)
                return 0, ""
            case ["docker", "compose", *_, "build"]:
                if self.head in self.broken:
                    return 1, ""
                self.build(tag, self.head)
                return 0, ""
            case ["docker", "compose", *_, "up", "-d", "--no-build", "--remove-orphans"]:
                if any(f"{repo}:{tag}" not in self.images for repo in REPOS):
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

    def save(self, current, previous=None):
        D.write_state(self.state_path, {"version": 1, "current": current, "previous": previous})

    def deployed(self, n, previous=None):
        """World and state as after a successful deploy of commit n."""
        self.world.build(sha(n)[:12], sha(n))
        self.world.run_on(sha(n)[:12])
        self.world.head = sha(n)
        self.save(rec(n), previous)


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
        for t in ["v0.11.0", "dev", "", "-c", "a..b", "x.lock", "main/", "a b", "latest"]:
            tags = self.TAGS if t != "latest" else set()
            with self.subTest(t=t), self.assertRaises(D.Refused):
                D.resolve_target(t, tags, self.BRANCHES)


class ComposeSupport(unittest.TestCase):
    def test_the_repo_compose_file_takes_the_tag_from_the_environment(self):
        self.assertTrue(D.supports_tagged_images(TAGGED))

    def test_a_compose_file_with_fixed_local_images_does_not(self):
        self.assertFalse(D.supports_tagged_images(UNTAGGED))


class State(unittest.TestCase):
    def test_missing_is_none_and_a_write_reads_back(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "deploy-state.json")
            self.assertIsNone(D.read_state(p))
            state = {"version": 1, "current": rec(2), "previous": rec(1)}
            D.write_state(p, state)
            self.assertEqual(D.read_state(p), state)
            self.assertEqual(os.listdir(d), ["deploy-state.json"])  # no temp file left behind
            self.assertEqual(stat.S_IMODE(os.stat(p).st_mode), 0o644)

    def test_unreadable_states_are_refused(self):
        bad = [
            "{not json",
            json.dumps({"version": 2, "current": rec(1), "previous": None}),  # newer build wrote it
            json.dumps({"version": 1, "current": {**rec(1), "tag": "../x"}, "previous": None}),
            json.dumps({"version": 1, "current": None, "previous": None}),
        ]
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "deploy-state.json")
            for text in bad:
                Path(p).write_text(text)
                with self.subTest(text=text), self.assertRaises(D.Refused):
                    D.read_state(p)

    def test_a_deploy_moves_current_to_previous_unless_it_is_the_same_commit(self):
        s = {"version": 1, "current": rec(2), "previous": rec(1)}
        self.assertEqual(D.after_deploy(s, rec(2), rec(3)), {"version": 1, "current": rec(3), "previous": rec(2)})
        again = rec(2, target="main")
        self.assertEqual(D.after_deploy(s, rec(2), again), {"version": 1, "current": again, "previous": rec(1)})
        legacy = rec(1, target="legacy", tag="local")
        self.assertEqual(D.after_deploy(None, legacy, rec(3)), {"version": 1, "current": rec(3), "previous": legacy})
        self.assertEqual(D.after_deploy(None, None, rec(3)), {"version": 1, "current": rec(3), "previous": None})

    def test_rolling_back_twice_returns_to_where_you_were(self):
        s = {"version": 1, "current": rec(2), "previous": rec(1)}
        self.assertEqual(D.after_rollback(s), {"version": 1, "current": rec(1), "previous": rec(2)})
        self.assertEqual(D.after_rollback(D.after_rollback(s)), s)


class PlanStart(unittest.TestCase):
    def images(self, tag):
        return {f"{r}:{tag}" for r in REPOS}

    def test_choices(self):
        s = {"version": 1, "current": rec(2), "previous": rec(1)}
        self.assertEqual(D.plan_start(s, self.images(sha(2)[:12])), ("up", rec(2)))
        self.assertEqual(D.plan_start(None, self.images("local") | {"postgres:17"}), ("legacy", None))
        self.assertEqual(D.plan_start(None, {"postgres:17", "learnharness-ocr:debug"}), ("deploy", None))
        self.assertEqual(D.plan_start(None, set()), ("deploy", None))

    def test_refusals_never_build(self):
        s = {"version": 1, "current": rec(2), "previous": rec(1)}
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
        self.assertEqual(r.state()["current"], {**rec(3, target="v0.10.0"), "time": "2026-11-12T12:00:00Z"})
        self.assertEqual(r.state()["previous"], rec(2))
        self.assertEqual(w.containers["learnharness-learnharness-1"][0], f"learnharness:{sha(3)[:12]}")
        self.assertEqual(sorted({i.split(":")[1] for i in w.images}), sorted([sha(2)[:12], sha(3)[:12]]))
        # Both commits stay in the checkout even if their branch or tag is deleted on origin.
        self.assertEqual((w.refs["refs/learnharness/current"], w.refs["refs/learnharness/previous"]), (sha(3), sha(2)))

    def test_a_failed_build_leaves_the_running_stack_and_the_checkout(self):
        w = World()
        r = Run(self, w)
        r.deployed(2, previous=rec(1))
        w.refs["refs/remotes/origin/main"] = sha(3)
        w.broken.add(sha(3))
        running = dict(w.containers)
        self.assertEqual(r.stack.deploy("main"), D.EXIT_FAILED)
        self.assertEqual(w.containers, running)
        self.assertFalse([c for c in w.calls if "up" in c])
        self.assertEqual(w.head, sha(2))
        self.assertEqual(r.state()["current"], rec(2))
        self.assertIn("build failed", r.lines[-1])

    def test_an_unhealthy_deploy_goes_back_by_itself(self):
        w = World()
        r = Run(self, w)
        r.deployed(2, previous=rec(1))
        w.tag("v0.3.0", sha(3))
        w.unhealthy.add(sha(3)[:12])
        self.assertEqual(r.stack.deploy("v0.3.0"), D.EXIT_FAILED)
        self.assertEqual(w.containers["learnharness-learnharness-1"][0], f"learnharness:{sha(2)[:12]}")
        self.assertEqual(w.head, sha(2))
        self.assertEqual(r.state(), {"version": 1, "current": rec(2), "previous": rec(1)})
        self.assertIn("not healthy", r.lines[-1])
        self.assertIn("back on v0.2.0", r.lines[-1])

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
        w.refs["refs/remotes/origin/main"] = sha(2)
        self.assertEqual(r.stack.deploy("main"), 0)
        self.assertEqual(r.state()["previous"], {"target": "legacy", "commit": sha(1), "tag": "local",
                                                 "time": "2026-11-12T12:00:00Z"})
        self.assertIn("learnharness:local", w.images)  # kept: it is the rollback target
        self.assertEqual(r.stack.rollback(), 0)
        self.assertEqual(w.containers["learnharness-learnharness-1"][0], "learnharness:local")
        self.assertEqual(w.head, sha(1))


class Rollback(unittest.TestCase):
    def test_twice_returns_and_never_builds(self):
        w = World()
        r = Run(self, w)
        w.build(sha(1)[:12], sha(1))
        r.deployed(2, previous=rec(1))
        self.assertEqual(r.stack.rollback(), 0)
        self.assertEqual((w.head, w.containers["learnharness-ocr-1"][0]), (sha(1), f"learnharness-ocr:{sha(1)[:12]}"))
        self.assertEqual(r.stack.rollback(), 0)
        self.assertEqual((w.head, w.containers["learnharness-ocr-1"][0]), (sha(2), f"learnharness-ocr:{sha(2)[:12]}"))
        self.assertEqual(r.state(), {"version": 1, "current": rec(2), "previous": rec(1)})
        self.assertEqual(w.builds(), [])
        self.assertFalse([c for c in w.calls if "fetch" in c])

    def test_refused_without_a_previous_deploy_or_its_images(self):
        w = World()
        r = Run(self, w)
        r.deployed(2)
        self.assertEqual(r.stack.rollback(), D.EXIT_FAILED)
        self.assertIn("no previous deploy", r.lines[-1])
        r.save(rec(2), rec(1))  # recorded, but its images are gone
        self.assertEqual(r.stack.rollback(), D.EXIT_FAILED)
        self.assertEqual(w.head, sha(2))
        self.assertEqual(r.state()["current"], rec(2))


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
        self.assertFalse([c for c in w.calls if "fetch" in c or c[-1] == "build"])

    def test_without_state_the_local_stack_starts_as_it_is(self):
        w = World()
        r = Run(self, w)
        w.build("local", sha(1))
        w.head = sha(1)
        self.assertEqual(r.stack.start("latest"), 0)
        self.assertEqual(w.containers["learnharness-learnharness-1"][0], "learnharness:local")
        self.assertIsNone(r.state())
        self.assertFalse([c for c in w.calls if "fetch" in c or "checkout" in c or c[-1] == "build"])

    def test_a_fresh_machine_deploys_the_default_target(self):
        w = World()
        r = Run(self, w)
        w.tag("v0.1.0", sha(1))
        self.assertEqual(r.stack.start("latest"), 0)
        self.assertEqual(r.state()["current"]["target"], "v0.1.0")

    def test_an_unreadable_state_is_not_overwritten_or_guessed_around(self):
        w = World()
        r = Run(self, w)
        Path(r.state_path).write_text("{")
        self.assertEqual(r.stack.start("latest"), D.EXIT_FAILED)
        self.assertEqual(r.stack.deploy("main"), D.EXIT_FAILED)
        self.assertEqual(Path(r.state_path).read_text(), "{")
        self.assertEqual(w.calls, [])


class Prune(unittest.TestCase):
    def test_the_weekly_prune_keeps_current_and_previous(self):
        w = World()
        r = Run(self, w)
        w.build(sha(1)[:12], sha(1))
        w.build(sha(0xA)[:12], sha(0xA))  # an older deploy nothing refers to
        r.deployed(2, previous=rec(1))
        self.assertEqual(r.stack.prune(["docker", "system", "prune", "-f", "--all"]), 0)
        self.assertEqual(sorted({i.split(":")[1] for i in w.images}), sorted([sha(1)[:12], sha(2)[:12]]))
        self.assertFalse([n for n in w.containers if n.startswith("learnharness-keep-")])


if __name__ == "__main__":
    unittest.main()

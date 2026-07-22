"""Fast unit tests for the autopilot daemon's failure handling and the
state-file contract. No network, no sleeps, no subprocesses — main() is
never invoked; only the pure/importable pieces are exercised.
"""
import ast
import json
from pathlib import Path

import pytest

from scraper import autopilot

FIXTURES = Path(__file__).parent / "fixtures"
GOLDEN = FIXTURES / "autopilot-state.json"


class FakeSpotifyException(Exception):
    """Mimics spotipy.SpotifyException's attribute surface."""

    def __init__(self, msg="", http_status=None, headers=None):
        super().__init__(msg)
        if http_status is not None:
            self.http_status = http_status
        if headers is not None:
            self.headers = headers


# ---------------------------------------------------------------- classify_error

class TestClassifyError:
    def test_429_status_with_retry_after(self):
        e = FakeSpotifyException("too many requests", http_status=429,
                                 headers={"Retry-After": "120"})
        assert autopilot.classify_error(e) == ("rate", 120.0)

    def test_429_lowercase_retry_after_header(self):
        e = FakeSpotifyException("too many requests", http_status=429,
                                 headers={"retry-after": "5"})
        assert autopilot.classify_error(e) == ("rate", 5.0)

    def test_429_no_headers(self):
        e = FakeSpotifyException("http 429", http_status=429)
        assert autopilot.classify_error(e) == ("rate", None)

    def test_429_bad_retry_after_value(self):
        e = FakeSpotifyException("x", http_status=429,
                                 headers={"Retry-After": "soon"})
        assert autopilot.classify_error(e) == ("rate", None)

    def test_rate_by_message_only(self):
        # non-SpotifyException failure: falls back to string matching
        assert autopilot.classify_error(Exception("Rate limit exceeded")) == ("rate", None)
        assert autopilot.classify_error(Exception("HTTP 429 from proxy")) == ("rate", None)

    def test_401_status(self):
        e = FakeSpotifyException("unauthorized", http_status=401)
        assert autopilot.classify_error(e) == ("auth", None)

    def test_auth_by_message(self):
        assert autopilot.classify_error(Exception("Access token expired")) == ("auth", None)
        assert autopilot.classify_error(Exception("got a 401 back")) == ("auth", None)

    def test_other(self):
        kind, ra = autopilot.classify_error(Exception("connection reset by peer"))
        assert kind == "other" and ra is None

    def test_rate_wins_over_auth_wording(self):
        # 429 check runs first, so a rate-limited refresh classifies as rate
        e = FakeSpotifyException("429 while refreshing access token", http_status=429)
        assert autopilot.classify_error(e)[0] == "rate"


# ------------------------------------------------------------ next_playing_state

class TestNextPlayingState:
    CM = 60.0

    def np(self, poll_ok, cp, playing, coast, now):
        return autopilot.next_playing_state(poll_ok, cp, playing, coast, now, self.CM)

    def test_success_playing_resets_coast(self):
        assert self.np(True, {"is_playing": True}, True, 100.0, 200.0) == (True, None)

    def test_success_starts_playing_from_stopped(self):
        assert self.np(True, {"is_playing": True}, False, None, 10.0) == (True, None)

    def test_success_not_playing_pauses_immediately(self):
        assert self.np(True, {"is_playing": False}, True, 50.0, 60.0) == (False, None)

    def test_success_none_payload_pauses_immediately(self):
        # currently_playing() returns None when nothing is playing
        assert self.np(True, None, True, None, 60.0) == (False, None)

    def test_first_failure_latches_coast_at_now(self):
        assert self.np(False, None, True, None, 1000.0) == (True, 1000.0)

    def test_failure_within_window_keeps_playing_and_latch(self):
        p, c = self.np(False, None, True, 1000.0, 1000.0 + self.CM)
        assert (p, c) == (True, 1000.0)  # exactly at the boundary: still coasting

    def test_failure_past_window_flips_paused(self):
        p, c = self.np(False, None, True, 1000.0, 1000.0 + self.CM + 0.001)
        assert p is False
        assert c == 1000.0  # latch is not reset by the flip

    def test_failure_while_not_playing_is_noop(self):
        assert self.np(False, None, False, None, 5.0) == (False, None)
        assert self.np(False, None, False, 1000.0, 2000.0) == (False, 1000.0)

    def test_recovery_after_coast_resumes(self):
        # fail, fail, then success: coast resets and playing holds
        p, c = self.np(False, None, True, None, 10.0)
        p, c = self.np(False, None, p, c, 30.0)
        assert (p, c) == (True, 10.0)
        p, c = self.np(True, {"is_playing": True}, p, c, 40.0)
        assert (p, c) == (True, None)

    def test_full_outage_sequence(self):
        p, c = True, None
        for t in (0.0, 20.0, 40.0, 60.0):
            p, c = self.np(False, None, p, c, t)
            assert p is True
        p, c = self.np(False, None, p, c, 61.0)
        assert p is False


# ---------------------------------------------------------------------- backoff

class TestBackoff:
    def test_rate_honors_retry_after(self):
        assert autopilot.rate_backoff_s(300.0, 2.0) == 300.0

    def test_rate_doubles_without_retry_after(self):
        assert autopilot.rate_backoff_s(None, 2.0) == 4.0
        assert autopilot.rate_backoff_s(None, 4.0) == 8.0

    def test_rate_takes_larger_of_retry_after_and_double(self):
        assert autopilot.rate_backoff_s(3.0, 4.0) == 8.0

    def test_rate_caps_at_900(self):
        assert autopilot.rate_backoff_s(48600.0, 2.0) == 900.0  # 13.5h Retry-After
        assert autopilot.rate_backoff_s(None, 800.0) == 900.0
        assert autopilot.POLL_BACKOFF_MAX_RATE_S == 900.0

    def test_auth_doubles_from_2s(self):
        assert [autopilot.auth_backoff_s(n) for n in (1, 2, 3, 4, 5)] == \
            [2.0, 4.0, 8.0, 16.0, 32.0]

    def test_auth_caps_at_60(self):
        assert autopilot.auth_backoff_s(6) == 60.0
        assert autopilot.auth_backoff_s(50) == 60.0
        assert autopilot.POLL_BACKOFF_MAX_S == 60.0

    def test_other_doubles_capped_at_60(self):
        assert autopilot.other_backoff_s(2.0) == 4.0
        assert autopilot.other_backoff_s(40.0) == 60.0

    def test_auth_tombstone_threshold_constant(self):
        assert autopilot.MAX_CONSECUTIVE_AUTH_FAILS == 10


# ------------------------------------------------------------------- tombstone

@pytest.fixture
def state_file(tmp_path, monkeypatch):
    f = tmp_path / "lightbox-autopilot.json"
    monkeypatch.setattr(autopilot, "STATE_FILE", f)
    monkeypatch.setattr(autopilot, "_tombstoned", False)
    return f


TOMBSTONE_KEYS = {"running", "pid", "exit_reason", "last_error",
                  "updated_at", "exited_at"}


class TestWriteTombstone:
    def test_schema_and_values(self, state_file):
        autopilot.write_tombstone("auth", "token dead")
        st = json.loads(state_file.read_text())
        assert set(st) == TOMBSTONE_KEYS
        assert st["running"] is False
        assert st["exit_reason"] == "auth"
        assert st["last_error"] == "token dead"
        assert isinstance(st["pid"], int)
        assert st["updated_at"] == st["exited_at"]

    def test_last_error_defaults_to_none(self, state_file):
        autopilot.write_tombstone("stopped")
        assert json.loads(state_file.read_text())["last_error"] is None

    def test_first_writer_wins(self, state_file):
        autopilot.write_tombstone("auth", "token dead")
        autopilot.write_tombstone("stopped")  # outer handler must not clobber
        st = json.loads(state_file.read_text())
        assert st["exit_reason"] == "auth"
        assert st["last_error"] == "token dead"

    def test_write_failure_is_swallowed(self, tmp_path, monkeypatch):
        monkeypatch.setattr(autopilot, "STATE_FILE", tmp_path)  # a dir: write fails
        monkeypatch.setattr(autopilot, "_tombstoned", False)
        autopilot.write_tombstone("crash", "boom")  # must not raise


# ------------------------------------------------------- state-file contract

def write_state_source_keys() -> set[str]:
    """String keys of the `state = {...}` dict inside write_state, parsed
    from source (write_state is a closure inside main and not importable)."""
    tree = ast.parse(Path(autopilot.__file__).read_text())
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef) and node.name == "write_state":
            for sub in ast.walk(node):
                if (isinstance(sub, ast.Assign)
                        and any(isinstance(t, ast.Name) and t.id == "state"
                                for t in sub.targets)
                        and isinstance(sub.value, ast.Dict)):
                    keys = {k.value for k in sub.value.keys
                            if isinstance(k, ast.Constant) and isinstance(k.value, str)}
                    assert keys, "write_state state dict has no string keys?"
                    return keys
    raise AssertionError("could not locate write_state's `state = {...}` dict")


class TestStateFileContract:
    def test_golden_fixture_covers_every_write_state_field(self):
        golden = set(json.loads(GOLDEN.read_text()))
        source = write_state_source_keys()
        missing = source - golden
        assert not missing, (
            f"write_state emits fields missing from the golden fixture "
            f"({sorted(missing)}) — update tests/fixtures/autopilot-state.json "
            f"AND the consumers (packages/server autopilot route / stem-sync)."
        )

    def test_golden_fixture_has_no_stale_fields(self):
        golden = set(json.loads(GOLDEN.read_text()))
        source = write_state_source_keys()
        stale = golden - source
        assert not stale, (
            f"golden fixture has fields write_state no longer emits: {sorted(stale)}"
        )

    def test_documented_core_fields_present(self):
        source = write_state_source_keys()
        assert {"running", "pid", "track_id", "track_name", "artists", "album",
                "art_url", "duration_s", "track_status", "playing",
                "coasting"} <= source

    def test_tombstone_keys_are_expected_subset(self, state_file):
        autopilot.write_tombstone("crash", "boom")
        st = json.loads(state_file.read_text())
        # tombstone shares the heartbeat's identity fields, plus exit metadata
        allowed = {"running", "pid", "updated_at"} | {"exit_reason", "last_error", "exited_at"}
        assert set(st) <= allowed
        assert {"running", "exit_reason"} <= set(st)

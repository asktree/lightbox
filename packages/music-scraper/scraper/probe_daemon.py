"""Latency-probe daemon — mic/camera access from the GUI login session.

macOS TCC refuses microphone and camera to any process descended from sshd
(silent zeros, no prompt). The dev server usually runs over SSH, so it can't
capture directly. This daemon runs as a LaunchAgent in the user's GUI session
(gui/501), where TCC attributes access to the Python binary and shows a
one-time on-screen prompt. The lightbox server calls it over localhost.

Endpoints (127.0.0.1:3009, JSON):
  GET  /health        → {ok: true}
  POST /audio         → run the click-train mic measurement (blocks ~8s)
  POST /video/start   → {duration?} begin webcam capture; returns once frames
                        are flowing so the caller can start flashing lights
  GET  /video/result  → blocks until the capture finishes; returns edges etc.

Install (one-time):
  launchctl bootstrap gui/501 ~/Library/LaunchAgents/com.lightbox.latency-probe.plist
"""
from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from scraper.latency_probe import run_audio, run_video

PORT = 3009

_lock = threading.Lock()          # one capture at a time, audio or video
_video_thread: threading.Thread | None = None
_video_result: dict | None = None
_video_ready = threading.Event()


def _video_worker(duration_s: float, camera_index: int) -> None:
    global _video_result
    try:
        _video_result = run_video(duration_s, camera_index, on_ready=_video_ready.set)
    except Exception as e:  # noqa: BLE001
        _video_result = {"ok": False, "error": f"video capture crashed: {e}"}
    finally:
        _video_ready.set()  # unblock /video/start even on early failure


class Handler(BaseHTTPRequestHandler):
    def _send(self, code: int, obj: dict) -> None:
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self) -> dict:
        n = int(self.headers.get("Content-Length") or 0)
        if n == 0:
            return {}
        try:
            return json.loads(self.rfile.read(n))
        except Exception:  # noqa: BLE001
            return {}

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/health":
            self._send(200, {"ok": True})
        elif self.path == "/video/result":
            global _video_thread
            if _video_thread is None:
                self._send(409, {"ok": False, "error": "no capture in progress"})
                return
            _video_thread.join(timeout=120)
            result = _video_result or {"ok": False, "error": "capture produced no result"}
            _video_thread = None
            _lock.release()
            self._send(200 if result.get("ok") else 500, result)
        else:
            self._send(404, {"ok": False, "error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        global _video_thread, _video_result
        if self.path == "/audio":
            if not _lock.acquire(blocking=False):
                self._send(409, {"ok": False, "error": "a capture is already running"})
                return
            try:
                result = run_audio()
            except Exception as e:  # noqa: BLE001
                result = {"ok": False, "error": f"audio capture crashed: {e}"}
            finally:
                _lock.release()
            self._send(200 if result.get("ok") else 500, result)
        elif self.path == "/video/start":
            if not _lock.acquire(blocking=False):
                self._send(409, {"ok": False, "error": "a capture is already running"})
                return
            body = self._body()
            duration = float(body.get("duration") or 16.0)
            camera = int(body.get("camera") or 0)
            _video_result = None
            _video_ready.clear()
            _video_thread = threading.Thread(target=_video_worker, args=(duration, camera), daemon=True)
            _video_thread.start()
            if not _video_ready.wait(timeout=15):
                # Leave the lock held — /video/result still owns cleanup.
                self._send(500, {"ok": False, "error": "camera never produced frames (permission?)"})
                return
            if _video_result is not None and not _video_result.get("ok"):
                res = _video_result
                _video_thread = None
                _lock.release()
                self._send(500, res)
                return
            self._send(200, {"ok": True})
        else:
            self._send(404, {"ok": False, "error": "not found"})

    def log_message(self, fmt: str, *args) -> None:  # noqa: ANN002
        print(f"[probe-daemon] {self.address_string()} {fmt % args}", flush=True)


def main() -> None:
    # macOS only shows the camera TCC consent dialog when the request comes
    # from the main thread (OpenCV: "can not spin main run loop from other
    # thread"). Touch the camera once here, before serving, so the one-time
    # prompt can appear; worker threads then open it without needing consent.
    try:
        import cv2
        print("[probe-daemon] pre-authorizing camera…", flush=True)
        cap = cv2.VideoCapture(0)
        ok = cap.isOpened()
        cap.release()
        print(f"[probe-daemon] camera {'authorized' if ok else 'NOT authorized (check the on-screen prompt / System Settings)'}", flush=True)
    except Exception as e:  # noqa: BLE001
        print(f"[probe-daemon] camera preauth failed: {e}", flush=True)

    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"[probe-daemon] listening on 127.0.0.1:{PORT}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()

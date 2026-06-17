import os
import sys
import uuid
import threading
import time
import subprocess
import shutil
from pathlib import Path

# ── Job store ─────────────────────────────────────────────────────────────────
_jobs: dict = {}
_jobs_lock = threading.Lock()

OUTPUTS_DIR = Path("outputs")
OUTPUTS_DIR.mkdir(exist_ok=True)

MODEL = "mdx"   # MDX-Net (CNN-only, no transformer) — 2-3x faster on CPU

# Use the same Python interpreter that is running Flask
PYTHON_EXE = sys.executable


def create_job() -> str:
    job_id = str(uuid.uuid4())
    with _jobs_lock:
        _jobs[job_id] = {
            "status": "queued",
            "progress": 0,
            "message": "Queued…",
            "stems": {},
        }
    return job_id


def get_job(job_id: str) -> dict | None:
    with _jobs_lock:
        return dict(_jobs.get(job_id, {}))


def _set(job_id: str, **kwargs):
    with _jobs_lock:
        if job_id in _jobs:
            _jobs[job_id].update(kwargs)


# ── Smooth progress animator ──────────────────────────────────────────────────
# Demucs tqdm uses \r carriage-return overwrites which don't flush reliably
# through subprocess pipes. Instead we animate progress based on time so the
# user always sees movement.
#
# Schedule: list of (target_pct, seconds_to_reach_it)
# Total duration ~6 minutes — tuned for mdx model on CPU.
_PROGRESS_SCHEDULE = [
    (10,   4),   # startup
    (18,  10),   # torch + model load
    (32,  30),   # first audio chunk
    (48,  45),   # processing
    (62,  50),   # processing
    (75,  45),   # processing
    (85,  35),   # final chunks
    (92,  25),   # encoding
    (97,  20),   # writing files
]

_MESSAGES = {
    10:  "Loading AI model…",
    18:  "Initialising MDX-Net…",
    32:  "Separating stems…",
    48:  "Separating stems…",
    62:  "Separating stems…",
    75:  "Separating stems…",
    85:  "Finishing up…",
    92:  "Encoding output files…",
    97:  "Writing stems to disk…",
}


def _smooth_progress(job_id: str, stop_event: threading.Event):
    """Animate progress smoothly regardless of subprocess output."""
    current = 5.0
    for target, duration in _PROGRESS_SCHEDULE:
        if stop_event.is_set():
            return
        steps = max(duration * 4, 1)   # update 4× per second
        delta = (target - current) / steps
        for _ in range(int(steps)):
            if stop_event.is_set():
                return
            time.sleep(0.25)
            current = min(current + delta, target)
            job = get_job(job_id)
            if not job or job.get("status") not in ("queued", "processing"):
                return
            msg = _MESSAGES.get(target, "Separating stems…")
            _set(job_id, progress=int(current), message=msg)

    # Slowly crawl from 98 → 99 over ~10 minutes so bar never looks frozen
    elapsed = 0
    while not stop_event.is_set():
        time.sleep(2)
        elapsed += 2
        # Pulse the message every 30 seconds so the user knows it's alive
        if elapsed % 30 == 0:
            mins = elapsed // 60
            msg = f"Still working… ({mins}m elapsed)" if mins > 0 else "Still working…"
            job = get_job(job_id)
            if job and job.get("status") == "processing":
                crawl = min(98 + (elapsed / 600), 99)   # reaches 99% after 10 min
                _set(job_id, progress=int(crawl), message=msg)


# ── Main separation function ──────────────────────────────────────────────────
def separate_audio(job_id: str, input_path: str):
    """Run Demucs separation in a background thread with smooth progress."""
    out_dir = OUTPUTS_DIR / job_id
    out_dir.mkdir(parents=True, exist_ok=True)

    _set(job_id, status="processing", progress=5, message="Starting…")

    runner = str(Path(__file__).parent / "demucs_runner.py")
    cmd = [
        PYTHON_EXE, runner,
        "--name", MODEL,
        "--out", str(out_dir),
        "--mp3",
        "--mp3-bitrate", "128",
        input_path,
    ]

    # Start the smooth progress animator
    stop_event = threading.Event()
    anim_thread = threading.Thread(
        target=_smooth_progress, args=(job_id, stop_event), daemon=True
    )
    anim_thread.start()

    stderr_lines = []

    try:
        process = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
        )

        # Drain stdout & stderr so the process never blocks on a full pipe
        def _drain(stream, store):
            for ln in stream:
                store.append(ln.rstrip())

        t_out = threading.Thread(target=_drain, args=(process.stdout, []), daemon=True)
        t_err = threading.Thread(target=_drain, args=(process.stderr, stderr_lines), daemon=True)
        t_out.start()
        t_err.start()

        process.wait()
        t_out.join(timeout=5)
        t_err.join(timeout=5)

    except FileNotFoundError as exc:
        stop_event.set()
        _set(job_id, status="error", progress=0,
             message=f"Demucs not found ({exc}). Run: pip install demucs")
        return
    except Exception as exc:
        stop_event.set()
        _set(job_id, status="error", progress=0,
             message=f"Unexpected error: {exc}")
        return
    finally:
        stop_event.set()          # always stop the animator
        anim_thread.join(timeout=2)
        try:
            os.remove(input_path)
        except OSError:
            pass

    # ── Check return code ─────────────────────────────────────────────────────
    if process.returncode != 0:
        clean_lines = [
            l for l in stderr_lines
            if l and not l.startswith("Traceback") and not l.startswith("  File ")
        ]
        clean_msg = clean_lines[-1] if clean_lines else "Demucs failed (unknown error)"
        _set(job_id, status="error", progress=0,
             message=f"Separation failed: {clean_msg}")
        return

    _set(job_id, progress=95, message="Locating output files…")

    # ── Collect stem files ────────────────────────────────────────────────────
    # Demucs layout: out_dir/<MODEL>/<song_name>/<stem>.mp3
    stem_names = ["vocals", "drums", "bass", "other"]
    stems = {}

    model_dirs = list(out_dir.iterdir())
    if not model_dirs:
        _set(job_id, status="error", message="No output directory found after separation.")
        return

    model_dir = model_dirs[0]
    song_dirs = list(model_dir.iterdir())
    if not song_dirs:
        _set(job_id, status="error", message="No song directory found after separation.")
        return

    song_dir = song_dirs[0]

    for stem in stem_names:
        for ext in ("mp3", "wav"):
            p = song_dir / f"{stem}.{ext}"
            if p.exists():
                stems[stem] = str(p.relative_to(OUTPUTS_DIR))
                break

    if not stems:
        _set(job_id, status="error",
             message="Stem files not found. Separation may have failed silently.")
        return

    _set(job_id, status="done", progress=100,
         message="Done! Your stems are ready.", stems=stems)

    # Cleanup after 1 hour
    threading.Timer(3600, _cleanup, args=[job_id, str(out_dir)]).start()


def _cleanup(job_id: str, path: str):
    """Remove output directory and job entry after TTL expires."""
    try:
        shutil.rmtree(path, ignore_errors=True)
    finally:
        with _jobs_lock:
            _jobs.pop(job_id, None)

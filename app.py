import os
import sys
import json
import threading
# Fix Windows console encoding for Python 3.13
if sys.platform == "win32":
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")
import time
from pathlib import Path
from flask import (
    Flask, render_template, request, jsonify,
    send_file, Response, abort
)
from werkzeug.utils import secure_filename
import separator
import transformer
import voice_changer

# ── Config ────────────────────────────────────────────────────────────────────
UPLOAD_FOLDER = Path("uploads")
UPLOAD_FOLDER.mkdir(exist_ok=True)

ALLOWED_EXTENSIONS = {"mp3", "wav", "flac", "ogg", "m4a", "aac", "wma"}
MAX_CONTENT_LENGTH = 150 * 1024 * 1024  # 150 MB

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = MAX_CONTENT_LENGTH
app.config["SECRET_KEY"] = os.urandom(24)


def allowed_file(filename: str) -> bool:
    return "." in filename and filename.rsplit(".", 1)[1].lower() in ALLOWED_EXTENSIONS


# ── Routes ────────────────────────────────────────────────────────────────────

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/upload", methods=["POST"])
def upload():
    if "file" not in request.files:
        return jsonify({"error": "No file provided"}), 400

    file = request.files["file"]
    if file.filename == "":
        return jsonify({"error": "No file selected"}), 400

    if not allowed_file(file.filename):
        return jsonify({"error": "Unsupported file format. Use MP3, WAV, FLAC, OGG, M4A, AAC or WMA"}), 400

    filename = secure_filename(file.filename)
    job_id = separator.create_job()
    save_path = str(UPLOAD_FOLDER / f"{job_id}_{filename}")
    file.save(save_path)

    # Run separation in background thread
    thread = threading.Thread(
        target=separator.separate_audio,
        args=(job_id, save_path),
        daemon=True,
    )
    thread.start()

    return jsonify({"job_id": job_id})


@app.route("/progress/<job_id>")
def progress(job_id: str):
    """Server-Sent Events stream for job progress."""
    def generate():
        while True:
            job = separator.get_job(job_id)
            if not job:
                data = json.dumps({"status": "error", "message": "Job not found"})
                yield f"data: {data}\n\n"
                return

            yield f"data: {json.dumps(job)}\n\n"

            if job["status"] in ("done", "error"):
                return

            time.sleep(0.4)

    return Response(
        generate(),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@app.route("/download/<job_id>/<stem>")
def download(job_id: str, stem: str):
    """Serve a separated stem file for download or streaming."""
    job = separator.get_job(job_id)
    if not job or job.get("status") != "done":
        abort(404)

    stems = job.get("stems", {})
    if stem not in stems:
        abort(404)

    file_path = Path("outputs") / stems[stem]
    if not file_path.exists():
        abort(404)

    as_attachment = request.args.get("dl", "0") == "1"
    return send_file(
        str(file_path),
        as_attachment=as_attachment,
        download_name=f"{stem}.{file_path.suffix.lstrip('.')}",
    )


@app.route("/status/<job_id>")
def status(job_id: str):
    """JSON snapshot of job status (for polling fallback)."""
    job = separator.get_job(job_id)
    if not job:
        return jsonify({"error": "Not found"}), 404
    return jsonify(job)


@app.route("/presets/<stem>")
def presets(stem: str):
    """Return available effect presets for a given stem type."""
    if stem == "vocals":
        # Vocals use voice identity conversion, not plain effects
        profiles = voice_changer.list_voice_profiles()
        return jsonify([{"key": p["key"], "label": p["label"]} for p in profiles])
    p = transformer.get_presets_for_stem(stem)
    # Return list of {key, label} for frontend dropdowns
    return jsonify([{"key": k, "label": v["label"]} for k, v in p.items()])


@app.route("/transform/<job_id>/<stem>", methods=["POST"])
def transform(job_id: str, stem: str):
    """Apply an audio effect preset to a separated stem."""
    job = separator.get_job(job_id)
    if not job or job.get("status") != "done":
        abort(404)

    stems = job.get("stems", {})
    if stem not in stems:
        abort(404)

    src_path = Path("outputs") / stems[stem]
    if not src_path.exists():
        abort(404)

    data = request.get_json(force=True, silent=True) or {}
    preset_key = data.get("preset", "original")

    try:
        if stem == "vocals":
            # Voice identity conversion (formant + pitch aware)
            out_path = voice_changer.convert_voice(str(src_path), preset_key)
            filename = Path(out_path).name
            return jsonify({
                "url":      f"/voice-converted/{filename}",
                "dl_url":   f"/voice-converted/{filename}?dl=1",
                "filename": filename,
            })
        else:
            # Instrument / drums — keep existing DSP effects
            out_path = transformer.transform_audio(str(src_path), stem, preset_key)
            filename = Path(out_path).name
            return jsonify({
                "url":      f"/transformed/{filename}",
                "dl_url":   f"/transformed/{filename}?dl=1",
                "filename": filename,
            })
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


@app.route("/transformed/<filename>")
def serve_transformed(filename: str):
    """Serve a transformed stem file (instruments/drums)."""
    safe_name = Path(filename).name
    file_path = Path("outputs") / "transformed" / safe_name
    if not file_path.exists():
        abort(404)
    as_attachment = request.args.get("dl", "0") == "1"
    stem_hint = request.args.get("stem", "audio")
    return send_file(
        str(file_path),
        as_attachment=as_attachment,
        download_name=f"{stem_hint}_transformed.wav",
    )


@app.route("/voice-converted/<filename>")
def serve_voice_converted(filename: str):
    """Serve a voice-converted vocal file."""
    safe_name = Path(filename).name
    file_path = Path("outputs") / "voice_converted" / safe_name
    if not file_path.exists():
        abort(404)
    as_attachment = request.args.get("dl", "0") == "1"
    return send_file(
        str(file_path),
        as_attachment=as_attachment,
        download_name="vocals_converted.wav",
    )


@app.route("/merge/<job_id>", methods=["POST"])
def merge_stems(job_id: str):
    """
    Merge all available stems for a job into a single WAV.
    POST body (JSON):
      {
        "tracks": {
          "vocals": {"volume": 100, "pan": 0, "muted": false},
          "drums":  {"volume": 80,  "pan": 0, "muted": false},
          ...
        },
        "master_volume": 100
      }
    volume: 0-200 (percent), pan: -100 (left) to 100 (right), muted: bool
    Returns: { "url": "/merged/<filename>", "dl_url": "/merged/<filename>?dl=1" }
    """
    import numpy as np
    import librosa as _lb
    import soundfile as _sf
    import uuid as _uuid
    import shutil as _shutil

    job = separator.get_job(job_id)
    if not job or job.get("status") != "done":
        return jsonify({"error": "Job not found or not complete"}), 404

    stems = job.get("stems", {})
    if not stems:
        return jsonify({"error": "No stems available"}), 400

    data = request.get_json(force=True, silent=True) or {}
    tracks_cfg = data.get("tracks", {})
    master_vol  = float(data.get("master_volume", 100)) / 100.0

    MERGED_DIR = Path("outputs") / "merged"
    MERGED_DIR.mkdir(parents=True, exist_ok=True)

    try:
        mixed    = None
        mix_sr   = None
        mix_len  = 0

        for stem, rel_path in stems.items():
            cfg = tracks_cfg.get(stem, {})
            if cfg.get("muted", False):
                continue

            vol = float(cfg.get("volume", 100)) / 100.0
            pan = float(cfg.get("pan", 0)) / 100.0   # -1.0 … 1.0

            src = Path("outputs") / rel_path
            if not src.exists():
                continue

            y, sr = _lb.load(str(src), sr=None, mono=True)

            # Apply volume
            y = y * vol

            # Convert to stereo with panning (constant power pan law)
            angle = (pan + 1.0) / 2.0 * (3.14159 / 2.0)
            import math
            left  = y * math.cos(angle)
            right = y * math.sin(angle)
            y_stereo = np.stack([left, right], axis=0)   # (2, N)

            if mixed is None:
                mix_sr  = sr
                mix_len = y_stereo.shape[1]
                mixed   = y_stereo.copy()
            else:
                # Resample to match if needed
                if sr != mix_sr:
                    y_stereo = _lb.resample(y_stereo, orig_sr=sr, target_sr=mix_sr)
                # Pad / trim to same length
                cur_len = y_stereo.shape[1]
                if cur_len > mix_len:
                    mixed  = np.pad(mixed, ((0,0),(0, cur_len - mix_len)))
                    mix_len = cur_len
                elif cur_len < mix_len:
                    y_stereo = np.pad(y_stereo, ((0,0),(0, mix_len - cur_len)))
                mixed = mixed + y_stereo

        if mixed is None:
            return jsonify({"error": "All tracks are muted — nothing to merge."}), 400

        # Master volume + normalize
        mixed = mixed * master_vol
        peak  = np.max(np.abs(mixed))
        if peak > 1.0:
            mixed = mixed / peak * 0.95

        out_name = f"merged_{_uuid.uuid4().hex[:8]}.wav"
        out_path = MERGED_DIR / out_name
        _sf.write(str(out_path), mixed.T, mix_sr)

        # Auto-cleanup after 2 hours
        threading.Timer(7200, lambda p=out_path: p.unlink(missing_ok=True)).start()

        return jsonify({
            "url":    f"/merged/{out_name}",
            "dl_url": f"/merged/{out_name}?dl=1",
        })

    except Exception as exc:
        return jsonify({"error": f"Merge failed: {exc}"}), 500


@app.route("/merged/<filename>")
def serve_merged(filename: str):
    """Serve a merged output WAV file."""
    safe_name = Path(filename).name
    file_path = Path("outputs") / "merged" / safe_name
    if not file_path.exists():
        abort(404)
    as_attachment = request.args.get("dl", "0") == "1"
    return send_file(
        str(file_path),
        as_attachment=as_attachment,
        download_name="merged_mix.wav",
    )


@app.route("/upload-stems", methods=["POST"])

def upload_stems():
    """
    Accept pre-separated stem files (vocals, drums, bass, other).
    Saves them into a new job output directory and registers a 'done' job
    so the results UI works identically to AI-separated stems.
    At least one stem file is required.
    """
    import shutil as _shutil

    VALID_STEMS = ["vocals", "drums", "bass", "other"]
    VALID_EXT   = {".mp3", ".wav", ".flac", ".ogg", ".m4a", ".aac"}

    job_id  = separator.create_job()
    out_dir = Path("outputs") / job_id
    out_dir.mkdir(parents=True, exist_ok=True)

    stems_saved = {}

    try:
        for stem in VALID_STEMS:
            f = request.files.get(stem)
            if not f or not f.filename:
                continue
            ext = Path(secure_filename(f.filename)).suffix.lower()
            if ext not in VALID_EXT:
                continue
            dest = out_dir / f"{stem}{ext}"
            f.save(str(dest))
            # Use forward slashes so path works on Windows AND as a URL fragment
            stems_saved[stem] = f"{job_id}/{stem}{ext}"

        if not stems_saved:
            _shutil.rmtree(str(out_dir), ignore_errors=True)
            with separator._jobs_lock:
                separator._jobs.pop(job_id, None)
            return jsonify({"error": "No valid stem files uploaded."}), 400

        # Mark job as done immediately — no AI processing needed
        separator._set(job_id,
                       status="done",
                       progress=100,
                       message="Pre-separated stems loaded.",
                       stems=stems_saved)

        # Auto-cleanup after 1 hour
        def _cleanup(p=str(out_dir), jid=job_id):
            _shutil.rmtree(p, ignore_errors=True)
            with separator._jobs_lock:
                separator._jobs.pop(jid, None)
        threading.Timer(3600, _cleanup).start()

        return jsonify({"job_id": job_id, "stems": stems_saved})

    except Exception as exc:
        # Always return JSON — never let Flask return an HTML error page
        _shutil.rmtree(str(out_dir), ignore_errors=True)
        with separator._jobs_lock:
            separator._jobs.pop(job_id, None)
        return jsonify({"error": f"Upload failed: {exc}"}), 500


# ── Video to MP3 Converter ──────────────────────────────────────────────────
video_jobs = {}
video_jobs_lock = threading.Lock()

def convert_video_to_mp3(job_id: str, temp_path: str, original_filename: str):
    """Background thread function to transcode video to MP3 using PyAV."""
    import av
    
    CONVERTED_DIR = Path("outputs") / "video_converter"
    CONVERTED_DIR.mkdir(parents=True, exist_ok=True)
    
    out_name = f"audio_{job_id[:8]}.mp3"
    out_path = CONVERTED_DIR / out_name
    
    try:
        input_container = av.open(temp_path)
        in_stream = next((s for s in input_container.streams if s.type == 'audio'), None)
        
        if not in_stream:
            raise ValueError("No audio track found in the uploaded video file.")
            
        out_container = av.open(str(out_path), 'w', format='mp3')
        out_stream = out_container.add_stream('libmp3lame')
        
        # Fixed output format for MP3
        out_stream.sample_rate = 44100
        out_stream.layout = 'stereo'
        out_stream.format = 's16p'
        
        resampler = av.AudioResampler(format='s16p', layout='stereo', rate=44100)
        
        duration_sec = float(input_container.duration) / av.time_base if input_container.duration else None
        last_progress_update = 0.0
        
        for packet in input_container.demux(in_stream):
            for frame in packet.decode():
                resampled_frames = resampler.resample(frame)
                if resampled_frames:
                    for rf in resampled_frames:
                        rf.pts = None
                        for op in out_stream.encode(rf):
                            out_container.mux(op)
                            
            # Progress reporting
            if duration_sec and packet.pts is not None and packet.time_base:
                current_sec = float(packet.pts) * float(packet.time_base)
                pct = min(99, int((current_sec / duration_sec) * 100))
                now = time.time()
                if pct > last_progress_update or now - last_progress_update > 1.5:
                    with video_jobs_lock:
                        if job_id in video_jobs:
                            video_jobs[job_id]["progress"] = pct
                            video_jobs[job_id]["message"] = f"Converting audio... {pct}%"
                    last_progress_update = pct
                    
        # Flush resampler
        resampled_frames = resampler.resample(None)
        if resampled_frames:
            for rf in resampled_frames:
                rf.pts = None
                for op in out_stream.encode(rf):
                    out_container.mux(op)
                    
        # Flush encoder
        for op in out_stream.encode(None):
            out_container.mux(op)
            
        input_container.close()
        out_container.close()
        
        # Verify file size
        if not out_path.exists() or out_path.stat().st_size == 0:
            raise IOError("Transcoding failed: empty output file generated.")
            
        # Success!
        with video_jobs_lock:
            if job_id in video_jobs:
                video_jobs[job_id].update({
                    "status": "done",
                    "progress": 100,
                    "message": "Conversion complete!",
                    "output_filename": out_name
                })
                
        # Auto-cleanup after 2 hours
        threading.Timer(7200, lambda p=out_path: p.unlink(missing_ok=True)).start()
        
    except Exception as exc:
        with video_jobs_lock:
            if job_id in video_jobs:
                video_jobs[job_id].update({
                    "status": "error",
                    "progress": 0,
                    "message": f"Conversion failed: {str(exc)}",
                    "error": str(exc)
                })
        # Clean up output file
        try:
            out_path.unlink(missing_ok=True)
        except OSError:
            pass
            
    finally:
        # Always cleanup temp upload file
        try:
            os.remove(temp_path)
        except OSError:
            pass


@app.route("/video-converter/upload-chunk", methods=["POST"])
def video_converter_upload_chunk():
    """Handles chunked uploads of video files."""
    upload_id = request.form.get("upload_id")
    chunk_index = int(request.form.get("chunk_index", 0))
    total_chunks = int(request.form.get("total_chunks", 1))
    filename = secure_filename(request.form.get("filename", "video.mp4"))
    
    chunk_file = request.files.get("chunk")
    if not chunk_file:
        return jsonify({"error": "No data chunk received."}), 400
        
    if not upload_id:
        return jsonify({"error": "Missing upload_id."}), 400
        
    temp_path = UPLOAD_FOLDER / f"video_{upload_id}.tmp"
    
    try:
        # Append chunk to file
        mode = "ab" if chunk_index > 0 else "wb"
        with open(temp_path, mode) as f:
            f.write(chunk_file.read())
            
        if chunk_index == total_chunks - 1:
            # Assembly complete, trigger conversion
            import uuid
            job_id = str(uuid.uuid4())
            with video_jobs_lock:
                video_jobs[job_id] = {
                    "status": "processing",
                    "progress": 0,
                    "message": "Extracting audio track...",
                    "output_filename": None,
                    "error": None
                }
                
            thread = threading.Thread(
                target=convert_video_to_mp3,
                args=(job_id, str(temp_path), filename),
                daemon=True
            )
            thread.start()
            
            return jsonify({"upload_complete": True, "job_id": job_id})
            
        return jsonify({"upload_complete": False})
        
    except Exception as exc:
        try:
            temp_path.unlink(missing_ok=True)
        except OSError:
            pass
        return jsonify({"error": f"Chunk upload failed: {exc}"}), 500


@app.route("/video-converter/status/<job_id>")
def video_converter_status(job_id: str):
    """Retrieve status of video converter job."""
    with video_jobs_lock:
        job = video_jobs.get(job_id)
    if not job:
        return jsonify({"error": "Job not found."}), 404
    return jsonify(job)


@app.route("/video-converter/download/<filename>")
def video_converter_download(filename: str):
    """Serve a converted video's MP3 file."""
    safe_name = Path(filename).name
    file_path = Path("outputs") / "video_converter" / safe_name
    if not file_path.exists():
        abort(404)
        
    as_attachment = request.args.get("dl", "0") == "1"
    download_name = request.args.get("name", "extracted_audio.mp3")
    if not download_name.endswith(".mp3"):
        download_name += ".mp3"
        
    return send_file(
        str(file_path),
        as_attachment=as_attachment,
        download_name=download_name,
    )
# ── Entry point ───────────────────────────────────────────────────────────────
if __name__ == "__main__":
    print("\n" + "=" * 50)
    print("  AudioExtractor is running!")
    port = int(os.environ.get("PORT", 5000))
    print(f"  Open: http://localhost:{port}")
    print("=" * 50 + "\n")
    app.run(debug=True, use_reloader=False, host="0.0.0.0", port=port, threaded=True)

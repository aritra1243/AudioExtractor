"""
transformer.py — Audio effect processing using librosa.
Applies pitch shift, speed change, and voice effects to separated stems.
"""

import os
import uuid
import threading
import numpy as np
from pathlib import Path

# Lazy-import librosa so Flask starts even before librosa is loaded
_librosa = None
_soundfile = None

def _load_libs():
    global _librosa, _soundfile
    if _librosa is None:
        import librosa as _lib
        import soundfile as _sf
        _librosa = _lib
        _soundfile = _sf


TRANSFORM_DIR = Path("outputs") / "transformed"
TRANSFORM_DIR.mkdir(parents=True, exist_ok=True)

# ── Preset definitions ─────────────────────────────────────────────────────────
# Each preset: pitch (semitones), speed (rate multiplier), robot (bool)
VOICE_PRESETS = {
    "original":   {"label": "Original",        "pitch": 0,   "speed": 1.0,  "robot": False},
    "higher":     {"label": "Higher (+3 st)",   "pitch": 3,   "speed": 1.0,  "robot": False},
    "chipmunk":   {"label": "Chipmunk (+8 st)", "pitch": 8,   "speed": 1.0,  "robot": False},
    "lower":      {"label": "Lower (-3 st)",    "pitch": -3,  "speed": 1.0,  "robot": False},
    "deep":       {"label": "Deep Voice (-8)",  "pitch": -8,  "speed": 1.0,  "robot": False},
    "robot":      {"label": "Robot Voice",      "pitch": 0,   "speed": 1.0,  "robot": True},
    "slow_vocal": {"label": "Slow Motion",      "pitch": 0,   "speed": 0.75, "robot": False},
    "fast_vocal": {"label": "Fast Forward",     "pitch": 0,   "speed": 1.5,  "robot": False},
}

INSTRUMENT_PRESETS = {
    "original":  {"label": "Original",         "pitch": 0,   "speed": 1.0},
    "up2":       {"label": "Key Up +2",         "pitch": 2,   "speed": 1.0},
    "up5":       {"label": "Key Up +5",         "pitch": 5,   "speed": 1.0},
    "up12":      {"label": "Octave Up (+12)",   "pitch": 12,  "speed": 1.0},
    "down2":     {"label": "Key Down -2",       "pitch": -2,  "speed": 1.0},
    "down5":     {"label": "Key Down -5",       "pitch": -5,  "speed": 1.0},
    "down12":    {"label": "Octave Down (-12)", "pitch": -12, "speed": 1.0},
    "slow":      {"label": "Slow (0.75x)",      "pitch": 0,   "speed": 0.75},
    "fast":      {"label": "Fast (1.25x)",      "pitch": 0,   "speed": 1.25},
    "veryfast":  {"label": "Very Fast (1.5x)",  "pitch": 0,   "speed": 1.5},
}

DRUMS_PRESETS = {
    "original":  {"label": "Original",          "pitch": 0,   "speed": 1.0},
    "up3":       {"label": "Tighter (+3 st)",   "pitch": 3,   "speed": 1.0},
    "down3":     {"label": "Looser (-3 st)",    "pitch": -3,  "speed": 1.0},
    "slow":      {"label": "Slow Beat (0.75x)", "pitch": 0,   "speed": 0.75},
    "fast":      {"label": "Fast Beat (1.25x)", "pitch": 0,   "speed": 1.25},
    "double":    {"label": "Double Time (2x)",  "pitch": 0,   "speed": 2.0},
    "half":      {"label": "Half Time (0.5x)",  "pitch": 0,   "speed": 0.5},
}

ALL_PRESETS = {
    "vocals": VOICE_PRESETS,
    "bass":   INSTRUMENT_PRESETS,
    "other":  INSTRUMENT_PRESETS,
    "drums":  DRUMS_PRESETS,
}


def get_presets_for_stem(stem: str) -> dict:
    return ALL_PRESETS.get(stem, INSTRUMENT_PRESETS)


def _robot_effect(y: np.ndarray, sr: int) -> np.ndarray:
    """Ring modulation robot voice effect."""
    t = np.linspace(0, len(y) / sr, len(y), endpoint=False)
    # Modulate at 60 Hz for metallic robot tone
    carrier = np.sin(2 * np.pi * 60 * t)
    y_mod = y * carrier
    # Add subtle harmonic distortion
    y_mod = np.tanh(y_mod * 2.5) * 0.7
    return y_mod


def _normalize(y: np.ndarray, target: float = 0.92) -> np.ndarray:
    """Peak-normalize audio to avoid clipping."""
    peak = np.max(np.abs(y))
    if peak > 0:
        y = y / peak * target
    return y


def transform_audio(input_path: str, stem: str, preset_key: str) -> str:
    """
    Apply the chosen effect preset to the audio file.
    Returns the path to the output WAV file.
    """
    _load_libs()
    lib = _librosa
    sf = _soundfile

    presets = get_presets_for_stem(stem)
    if preset_key not in presets:
        preset_key = "original"
    params = presets[preset_key]

    pitch  = float(params.get("pitch", 0))
    speed  = float(params.get("speed", 1.0))
    robot  = bool(params.get("robot", False))

    # Load audio (mono for speed; keep native sample rate)
    y, sr = lib.load(input_path, sr=None, mono=True)

    # ── Pitch shift ──────────────────────────────────────────────────────────
    if pitch != 0:
        y = lib.effects.pitch_shift(
            y, sr=sr, n_steps=pitch, res_type="kaiser_fast"
        )

    # ── Time stretch / speed ─────────────────────────────────────────────────
    if speed != 1.0:
        y = lib.effects.time_stretch(y, rate=speed)

    # ── Robot effect ─────────────────────────────────────────────────────────
    if robot:
        y = _robot_effect(y, sr)

    # Normalize to avoid clipping
    y = _normalize(y)

    # ── Write output WAV ─────────────────────────────────────────────────────
    out_name = f"{uuid.uuid4().hex}.wav"
    out_path = TRANSFORM_DIR / out_name
    sf.write(str(out_path), y, sr)

    # Schedule cleanup after 2 hours
    threading.Timer(7200, lambda p=out_path: p.unlink(missing_ok=True)).start()

    return str(out_path)

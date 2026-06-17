"""
voice_changer.py — Formant-aware Voice Conversion
===================================================
Converts vocal identity (not just pitch) using:
  - Pedalboard's PitchShift for precise semitone shift
  - Formant ratio correction (via resampling trick) to change vocal tract length
  - Librosa time-stretch to keep duration intact
  - Final normalization

This gives convincing male→female, female→male, and character voice changes
without requiring any AI model downloads — works 100% offline.

Voice profiles
--------------
Each profile has:
  pitch_steps  : semitones to shift (negative = lower, positive = higher)
  formant_ratio: vocal-tract scale factor
                 >1.0 = shorter tract  = brighter / more feminine
                 <1.0 = longer  tract  = darker   / more masculine
  speed        : playback rate (1.0 = unchanged)
"""

import uuid
import threading
import numpy as np
from pathlib import Path

# Lazy imports
_librosa    = None
_soundfile  = None
_pedalboard = None
_pb_plugins = None

def _load_libs():
    global _librosa, _soundfile, _pedalboard, _pb_plugins
    if _librosa is None:
        import librosa as _lb
        import soundfile as _sf
        import pedalboard as _pb
        _librosa    = _lb
        _soundfile  = _sf
        _pedalboard = _pb
        _pb_plugins = _pb


# ── Output directory ──────────────────────────────────────────────────────────
VOICE_OUT_DIR = Path("outputs") / "voice_converted"
VOICE_OUT_DIR.mkdir(parents=True, exist_ok=True)


# ── Voice profiles ────────────────────────────────────────────────────────────
VOICE_PROFILES = {
    "original": {
        "label":        "Original Voice",
        "pitch_steps":   0,
        "formant_ratio": 1.0,
        "speed":         1.0,
        "description":  "Keep the original vocal as-is",
    },
    "female_1": {
        "label":        "Female Voice",
        "pitch_steps":   5,
        "formant_ratio": 1.18,
        "speed":         1.0,
        "description":  "Convert to a natural female voice",
    },
    "female_2": {
        "label":        "Soft Female",
        "pitch_steps":   7,
        "formant_ratio": 1.22,
        "speed":         1.0,
        "description":  "Softer, higher-pitched female voice",
    },
    "female_breathy": {
        "label":        "Breathy Female",
        "pitch_steps":   6,
        "formant_ratio": 1.20,
        "speed":         0.97,
        "description":  "Airy, breathy feminine quality",
    },
    "male_deep": {
        "label":        "Deep Male",
        "pitch_steps":  -5,
        "formant_ratio": 0.82,
        "speed":         1.0,
        "description":  "Deep, rich masculine voice",
    },
    "male_young": {
        "label":        "Young Male",
        "pitch_steps":  -2,
        "formant_ratio": 0.92,
        "speed":         1.0,
        "description":  "Lighter, younger-sounding male voice",
    },
    "male_heroic": {
        "label":        "Heroic Male",
        "pitch_steps":  -4,
        "formant_ratio": 0.85,
        "speed":         1.0,
        "description":  "Powerful, dramatic male tone",
    },
    "child": {
        "label":        "Child Voice",
        "pitch_steps":   10,
        "formant_ratio": 1.35,
        "speed":         1.02,
        "description":  "High-pitched, childlike vocal quality",
    },
    "elder": {
        "label":        "Elder Voice",
        "pitch_steps":  -3,
        "formant_ratio": 0.88,
        "speed":         0.95,
        "description":  "Older, warmer vocal character",
    },
}


def list_voice_profiles() -> list[dict]:
    """Return [{key, label, description}, ...] sorted with 'original' first."""
    result = []
    for key, prof in VOICE_PROFILES.items():
        result.append({
            "key":         key,
            "label":       prof["label"],
            "description": prof["description"],
        })
    return result


def _formant_shift(y: np.ndarray, sr: int, ratio: float) -> np.ndarray:
    """
    Shift formants by resampling the signal:
      ratio > 1 → upsample then downsample → shorter perceived vocal tract (brighter)
      ratio < 1 → downsample then upsample → longer perceived vocal tract (darker)
    We do this at the *original* pitch so it only changes timbre, not pitch.
    """
    lib = _librosa
    if abs(ratio - 1.0) < 0.01:
        return y  # nothing to do

    original_len = len(y)
    # Step 1: stretch time so pitch stays same after resampling
    stretched = lib.effects.time_stretch(y, rate=ratio)
    # Step 2: resample back to original length to undo the duration change
    # This makes duration ~same but formants shifted
    if len(stretched) == 0:
        return y
    target_len = original_len
    # Use scipy resample for high quality
    from scipy.signal import resample
    shifted = resample(stretched, target_len)
    return shifted.astype(np.float32)


def _apply_pitch_shift_pedalboard(y: np.ndarray, sr: int, semitones: float) -> np.ndarray:
    """Use pedalboard PitchShift (high quality, preserves formants better than librosa)."""
    pb = _pedalboard
    if semitones == 0:
        return y

    board = pb.Pedalboard([
        pb.PitchShift(semitones=semitones),
    ])
    # pedalboard expects float32 stereo (channels, samples); we have mono
    y_stereo = np.stack([y, y], axis=0)   # (2, N)
    out = board(y_stereo, sr)             # (2, N)
    mono = (out[0] + out[1]) * 0.5
    return mono.astype(np.float32)


def _normalize(y: np.ndarray, target: float = 0.92) -> np.ndarray:
    peak = np.max(np.abs(y))
    if peak > 0:
        y = y / peak * target
    return y


def convert_voice(input_path: str, profile_key: str) -> str:
    """
    Apply voice conversion to the given WAV/MP3 file.
    Returns path to the output WAV file.
    """
    _load_libs()
    lib = _librosa
    sf  = _soundfile

    if profile_key not in VOICE_PROFILES:
        profile_key = "original"

    profile = VOICE_PROFILES[profile_key]
    pitch_steps   = float(profile["pitch_steps"])
    formant_ratio = float(profile["formant_ratio"])
    speed         = float(profile["speed"])

    # Load audio (mono, native sample rate)
    y, sr = lib.load(input_path, sr=None, mono=True)

    if profile_key == "original":
        # Just normalize and return
        y = _normalize(y)
        out_name = f"{uuid.uuid4().hex}.wav"
        out_path = VOICE_OUT_DIR / out_name
        sf.write(str(out_path), y, sr)
        _schedule_cleanup(out_path)
        return str(out_path)

    # ── Step 1: Formant shift (changes vocal tract = voice character) ─────────
    y = _formant_shift(y, sr, formant_ratio)

    # ── Step 2: Pitch shift (changes perceived pitch / gender) ────────────────
    if pitch_steps != 0:
        y = _apply_pitch_shift_pedalboard(y, sr, pitch_steps)

    # ── Step 3: Speed / tempo adjustment ─────────────────────────────────────
    if abs(speed - 1.0) > 0.01:
        y = lib.effects.time_stretch(y, rate=speed)

    # ── Normalize ─────────────────────────────────────────────────────────────
    y = _normalize(y)

    # ── Write output ──────────────────────────────────────────────────────────
    out_name = f"{uuid.uuid4().hex}.wav"
    out_path = VOICE_OUT_DIR / out_name
    sf.write(str(out_path), y, sr)

    _schedule_cleanup(out_path)
    return str(out_path)


def _schedule_cleanup(path: Path, delay: int = 7200):
    """Auto-delete converted file after delay seconds (default 2 hours)."""
    threading.Timer(delay, lambda p=path: p.unlink(missing_ok=True)).start()

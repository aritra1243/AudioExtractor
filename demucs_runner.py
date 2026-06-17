"""
demucs_runner.py
────────────────
Patches torchaudio.load/save to use soundfile (bypassing TorchCodec)
BEFORE demucs imports anything, fixing the Windows incompatibility in
torchaudio 2.11+ which hardcoded torchcodec as the default backend.
"""
import sys
import os
import types

# ── Patch torchaudio.load and torchaudio.save with soundfile versions ─────────
# Must happen before ANY other import that might trigger torchaudio internals.
import torch
import torchaudio

def _soundfile_load(uri, frame_offset=0, num_frames=-1, normalize=True,
                    channels_first=True, format=None, buffer_size=4096, backend=None):
    """soundfile-based torchaudio.load replacement — no TorchCodec needed."""
    import soundfile as sf
    import numpy as np

    data, sr = sf.read(str(uri), always_2d=True, dtype="float32")
    # soundfile: (frames, channels) → torchaudio wants (channels, frames)
    if channels_first:
        data = data.T
    if frame_offset > 0:
        data = data[..., frame_offset:] if channels_first else data[frame_offset:]
    if num_frames > 0:
        data = data[..., :num_frames] if channels_first else data[:num_frames]
    tensor = torch.from_numpy(np.ascontiguousarray(data))
    return tensor, sr


def _soundfile_save(uri, src, sample_rate, channels_first=True, format=None,
                    encoding=None, bits_per_sample=None, buffer_size=4096,
                    backend=None, compression=None):
    """soundfile-based torchaudio.save replacement — no TorchCodec needed."""
    import soundfile as sf
    import numpy as np

    arr = src.numpy()
    # torchaudio: (channels, frames) → soundfile wants (frames, channels)
    if channels_first and arr.ndim == 2:
        arr = arr.T
    sf.write(str(uri), arr, sample_rate)


# Patch both torchaudio.load and torchaudio.load_with_torchcodec
torchaudio.load                   = _soundfile_load
torchaudio.load_with_torchcodec   = _soundfile_load
torchaudio.save                   = _soundfile_save
torchaudio.save_with_torchcodec   = _soundfile_save

# Also patch the _torchcodec submodule functions if they exist
try:
    import torchaudio._torchcodec as _tc
    _tc.load_with_torchcodec = _soundfile_load
    _tc.save_with_torchcodec = _soundfile_save
except Exception:
    pass

# ── Run demucs with the patched torchaudio ─────────────────────────────────────
# Do NOT wrap in sys.exit(): run_module() returns the module globals dict on
# success, and sys.exit(dict) prints it to stderr then exits with code 1,
# making a successful run look like an error.
# If demucs internally calls sys.exit(0), the SystemExit propagates naturally.
import runpy
runpy.run_module("demucs", run_name="__main__", alter_sys=True)


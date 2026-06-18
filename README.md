---
title: AudioExtractor
emoji: 🎵
colorFrom: purple
colorTo: blue
sdk: docker
app_port: 7860
pinned: false
short_description: AI-powered audio stem separation using Demucs
---

# AudioExtractor 🎵

AI-powered audio source separation and stem extractor. Upload any song and split it into individual stems: **vocals**, **drums**, **bass**, and **other instruments**.

## Features

- 🎤 **Stem Separation** — Powered by Facebook's Demucs MDX model
- 🎛️ **Audio Effects** — Reverb, EQ, compression, delay via Pedalboard
- 🎙️ **Voice Changer** — Pitch shift and vocal transformation
- 🎬 **Chrome Extension** — Convert MP4 to MP3 locally in your browser (no upload needed)

## How to Use

1. Upload an audio file (MP3, WAV, FLAC, OGG, M4A — max 150 MB)
2. Click **Separate Stems**
3. Wait ~2–5 minutes for AI processing
4. Download individual stems

## Tech Stack

- **Backend**: Python, Flask, Demucs, PyTorch, Pedalboard, librosa
- **Frontend**: Vanilla HTML/CSS/JS
- **Deployment**: Hugging Face Spaces (Docker)

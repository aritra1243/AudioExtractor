# ── Base image ────────────────────────────────────────────────────────────────
FROM python:3.11-slim

# ── System dependencies ────────────────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    libsndfile1 \
    libsndfile1-dev \
    git \
    curl \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# ── Working directory ──────────────────────────────────────────────────────────
WORKDIR /app

# ── Install Python dependencies first (Docker layer cache) ────────────────────
COPY requirements.txt .
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r requirements.txt

# ── Pre-download the MDX demucs model so first request isn't slow ─────────────
# This bakes the model weights into the image (~80 MB)
RUN python -c "\
import torch; \
from demucs.pretrained import get_model; \
get_model('mdx'); \
print('MDX model downloaded successfully')"

# ── Copy application source ────────────────────────────────────────────────────
COPY . .

# ── Create runtime directories ────────────────────────────────────────────────
RUN mkdir -p uploads outputs && chmod 777 uploads outputs

# ── Hugging Face Spaces runs on port 7860 ─────────────────────────────────────
ENV PORT=7860
EXPOSE 7860

# ── Auto-cleanup: remove uploads/outputs older than 1 hour (run at startup) ───
# HF Spaces has ephemeral storage — files are lost on restart anyway
RUN echo '#!/bin/bash\n\
find /app/uploads -type f -mmin +60 -delete 2>/dev/null || true\n\
find /app/outputs -type f -mmin +60 -delete 2>/dev/null || true\n\
exec gunicorn --bind 0.0.0.0:7860 --timeout 600 --workers 1 --threads 4 app:app' \
> /app/start.sh && chmod +x /app/start.sh

CMD ["/app/start.sh"]

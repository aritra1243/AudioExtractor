import urllib.request
import os
from pathlib import Path

# URLs for single-threaded FFmpeg.wasm core assets
ASSETS = {
    "ffmpeg-core.js": "https://unpkg.com/@ffmpeg/core-st@0.11.0/dist/ffmpeg-core.js",
    "ffmpeg-core.wasm": "https://unpkg.com/@ffmpeg/core-st@0.11.0/dist/ffmpeg-core.wasm",
}

def main():
    dest_dir = Path(__file__).parent
    print("--------------------------------------------------")
    print("Downloading offline single-threaded WebAssembly core assets...")
    print("--------------------------------------------------")

    for filename, url in ASSETS.items():
        dest_path = dest_dir / filename
        print(f"Downloading {filename}...")
        try:
            req = urllib.request.Request(
                url, 
                headers={'User-Agent': 'Mozilla/5.0'}
            )
            with urllib.request.urlopen(req) as response:
                with open(dest_path, "wb") as f:
                    f.write(response.read())
            print(f" Successfully saved {filename}")
        except Exception as e:
            print(f"❌ Failed to download {filename}: {e}")
            return

    # Delete any residual worker file if present to keep directory clean
    residual_worker = dest_dir / "ffmpeg-core.worker.js"
    if residual_worker.exists():
        residual_worker.unlink()

    print("\nAll assets downloaded successfully! Your extension folder is ready.")
    print("You can now reload this folder in Chrome.")

if __name__ == "__main__":
    main()

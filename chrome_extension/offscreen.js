// Listen for message events from background service worker to start conversion
chrome.runtime.onMessage.addListener(async (message) => {
  if (message.action === 'startOffscreenConvert') {
    const { fileName } = message;
    try {
      chrome.runtime.sendMessage({ action: 'updateStatus', status: 'loading' });

      // 1. Fetch local WASM binary (safe in this environment, no CORS)
      const wasmRes = await fetch(chrome.runtime.getURL("ffmpeg-core.wasm"));
      if (!wasmRes.ok) throw new Error("Failed to load ffmpeg-core.wasm");
      const wasmBinary = await wasmRes.arrayBuffer();

      // 2. Read the video file from the shared IndexedDB
      chrome.runtime.sendMessage({ action: 'updateStatus', status: 'writing' });
      const videoBuffer = await getFile('input_video');
      if (!videoBuffer) throw new Error("Video input buffer not found in database.");

      // 3. Instantiate the Emscripten core; wrap in a Promise that resolves on quit
      await new Promise((resolve, reject) => {
        const Module = {
          wasmBinary: wasmBinary,
          print: (text) => console.log("[WASM stdout]", text),
          printErr: (text) => {
            console.warn("[WASM stderr]", text);
            // Parse progress markers
            if (text.includes("Duration:")) {
              const match = text.match(/Duration:\s*(\d{2}:\d{2}:\d{2}\.\d{2})/);
              if (match) {
                chrome.runtime.sendMessage({ action: 'duration', duration: match[1] });
              }
            } else if (text.includes("time=")) {
              const match = text.match(/time=\s*(\d{2}:\d{2}:\d{2}\.\d{2})/);
              if (match) {
                chrome.runtime.sendMessage({ action: 'progressTime', time: match[1] });
              }
            }
          },
          // Called when the WASM module has fully loaded and is ready
          onRuntimeInitialized: () => {
            try {
              // 4. Mount video buffer to virtual filesystem
              Module.FS.writeFile('input_video', new Uint8Array(videoBuffer));

              chrome.runtime.sendMessage({ action: 'updateStatus', status: 'converting' });

              const args = [
                'ffmpeg',
                '-nostdin',
                '-y',
                '-i', 'input_video',
                '-vn',
                '-acodec', 'libmp3lame',
                '-ab', '128k',
                'output.mp3'
              ];

              // 5. Execute conversion – callMain is synchronous in single-threaded WASM builds
              if (typeof Module.callMain === 'function') {
                Module.callMain(args);
              } else {
                const argc = args.length;
                const argv = Module._malloc(argc * 4);
                for (let i = 0; i < argc; i++) {
                  const arg = args[i];
                  const len = Module.lengthBytesUTF8(arg) + 1;
                  const ptr = Module._malloc(len);
                  Module.stringToUTF8(arg, ptr, len);
                  Module.setValue(argv + i * 4, ptr, 'i32');
                }
                const mainFn = Module._proxy_main || Module._main;
                if (typeof mainFn === 'function') {
                  mainFn(argc, argv);
                } else {
                  reject(new Error("FFmpeg main entry point not found in WASM core."));
                  return;
                }
              }

              // 6. Read output after synchronous call completes
              chrome.runtime.sendMessage({ action: 'updateStatus', status: 'reading' });
              const data = Module.FS.readFile('output.mp3');

              // 7. Cleanup WASM heap memory
              try { Module.FS.unlink('input_video'); } catch (_) {}
              try { Module.FS.unlink('output.mp3'); } catch (_) {}

              resolve(data);
            } catch (err) {
              reject(err);
            }
          },
          // Handle Module-level errors (e.g. OOM, abort)
          onAbort: (reason) => reject(new Error(`WASM aborted: ${reason}`)),
          quit: (code, err) => {
            if (code !== 0 && err) reject(err);
          }
        };

        // Bootstrap the Emscripten module (createFFmpegCore is defined by ffmpeg-core.js)
        createFFmpegCore(Module).catch(reject);
      }).then(async (data) => {
        // 8. Write the output MP3 data directly back to IndexedDB
        await setFile('output_mp3', data.buffer);

        // 9. Notify completion
        chrome.runtime.sendMessage({
          action: 'updateStatus',
          status: 'done',
          fileName: fileName.replace(/\.[^/.]+$/, "") + ".mp3"
        });
      });

    } catch (error) {
      console.error("Offscreen processor failed:", error);
      chrome.runtime.sendMessage({
        action: 'updateStatus',
        status: 'error',
        message: error.message || error.toString()
      });
    }
  }
});

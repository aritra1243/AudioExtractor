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
            // FFmpeg writes ALL its output (banner, stream info, progress) to stderr by design.
            // Only treat lines that look like genuine errors as warnings.
            const isRealError = /^\s*(Error|error|Invalid|No such|Failed|Cannot|Could not|Unable)/i.test(text)
              && !text.includes('Warning:')
              && !text.includes('version ')
              && !text.includes('configuration:')
              && !text.includes('built with');

            if (isRealError) {
              console.warn("[WASM stderr]", text);
            } else {
              console.log("[WASM stderr]", text);
            }

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
            // 4. Mount video buffer to virtual filesystem
            try {
              Module.FS.writeFile('input_video', new Uint8Array(videoBuffer));
            } catch (fsErr) {
              reject(new Error("Failed to write input to WASM FS: " + fsErr.message));
              return;
            }

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

            // 5. Execute conversion.
            // Emscripten throws {name:"ExitStatus", status:N} when _main returns.
            // Exit code 0 means success — we must NOT treat it as an error.
            try {
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
                if (typeof mainFn !== 'function') {
                  reject(new Error("FFmpeg main entry point not found in WASM core."));
                  return;
                }
                mainFn(argc, argv);
              }
            } catch (exitErr) {
              // Emscripten raises ExitStatus on program exit — check exit code
              if (exitErr && exitErr.name === 'ExitStatus') {
                if (exitErr.status !== 0) {
                  // Non-zero = FFmpeg encountered a real error
                  reject(new Error(`FFmpeg exited with code ${exitErr.status}`));
                  return;
                }
                // Exit code 0 = success, fall through to read output below
              } else {
                // Unexpected runtime error
                reject(exitErr instanceof Error ? exitErr : new Error(String(exitErr)));
                return;
              }
            }

            // 6. Read output after conversion completes
            let data;
            try {
              chrome.runtime.sendMessage({ action: 'updateStatus', status: 'reading' });
              data = Module.FS.readFile('output.mp3');
            } catch (readErr) {
              reject(new Error("Failed to read output.mp3 from WASM FS: " + readErr.message));
              return;
            }

            // 7. Cleanup WASM virtual filesystem
            try { Module.FS.unlink('input_video'); } catch (_) {}
            try { Module.FS.unlink('output.mp3'); } catch (_) {}

            resolve(data);
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

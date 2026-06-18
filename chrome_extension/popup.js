let selectedFile = null;
let videoDuration = 0;

const dropZone = document.getElementById("drop-zone");
const fileInput = document.getElementById("file-input");
const fileDetails = document.getElementById("file-details");
const fileNameEl = document.getElementById("file-name");
const fileSizeEl = document.getElementById("file-size");
const convertBtn = document.getElementById("convert-btn");
const progressContainer = document.getElementById("progress-container");
const progressFill = document.getElementById("progress-fill");
const statusText = document.getElementById("status-text");
const progressPct = document.getElementById("progress-pct");
const sandboxIframe = document.getElementById("sandbox-iframe");

// Handle File Input Interactions
dropZone.addEventListener("click", () => fileInput.click());

dropZone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropZone.style.borderColor = "var(--purple)";
});

dropZone.addEventListener("dragleave", () => {
  dropZone.style.borderColor = "var(--border)";
});

dropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropZone.style.borderColor = "var(--border)";
  if (e.dataTransfer.files.length > 0) {
    handleFile(e.dataTransfer.files[0]);
  }
});

fileInput.addEventListener("change", (e) => {
  if (e.target.files.length > 0) {
    handleFile(e.target.files[0]);
  }
});

function handleFile(file) {
  selectedFile = file;
  fileNameEl.textContent = file.name;
  fileSizeEl.textContent = `${(file.size / (1024 * 1024)).toFixed(1)} MB`;
  
  fileDetails.classList.remove("hidden");
  convertBtn.disabled = false;
}

// Convert logic trigger
convertBtn.addEventListener("click", async () => {
  if (!selectedFile) return;

  convertBtn.disabled = true;
  progressContainer.classList.remove("hidden");
  
  statusText.textContent = "Loading WebAssembly core...";
  progressFill.style.width = "5%";
  progressPct.textContent = "5%";

  try {
    // 1. Fetch local WASM binary (no CORS restrictions inside extension execution contexts)
    const wasmRes = await fetch(chrome.runtime.getURL("ffmpeg-core.wasm"));
    if (!wasmRes.ok) throw new Error("Failed to load ffmpeg-core.wasm from extension package.");
    const wasmBinary = await wasmRes.arrayBuffer();

    statusText.textContent = "Reading video file...";
    progressFill.style.width = "15%";
    progressPct.textContent = "15%";

    // 2. Read the user's video file as ArrayBuffer
    const reader = new FileReader();
    reader.onload = function(e) {
      const videoBuffer = e.target.result;
      
      statusText.textContent = "Initializing Transcoder...";
      progressFill.style.width = "25%";
      progressPct.textContent = "25%";

      // Reset video duration tracking
      videoDuration = 0;

      // 3. Post array buffers to sandboxed iframe using transferable references (instant, no copy memory)
      sandboxIframe.contentWindow.postMessage({
        action: 'convert',
        fileData: videoBuffer,
        wasmBinary: wasmBinary,
        fileName: selectedFile.name
      }, '*', [videoBuffer, wasmBinary]);
    };
    
    reader.onerror = function() {
      throw new Error("Failed to read video file into memory.");
    };

    reader.readAsArrayBuffer(selectedFile);

  } catch (error) {
    console.error("Popup initiation error:", error);
    statusText.textContent = `Error: ${error.message || error}`;
    statusText.style.color = "#ef4444";
    convertBtn.disabled = false;
  }
});

// Helper to convert time format (HH:MM:SS.ms) to seconds
function parseTimeToSeconds(timeStr) {
  const parts = timeStr.trim().split(":");
  if (parts.length !== 3) return 0;
  const hrs = parseFloat(parts[0]);
  const mins = parseFloat(parts[1]);
  const secs = parseFloat(parts[2]);
  return (hrs * 3600) + (mins * 60) + secs;
}

// Listen for messages back from the Sandboxed Iframe
window.addEventListener('message', (event) => {
  const { status, ratio, mp3Data, fileName, message, log } = event.data;
  
  if (status === 'loading') {
    statusText.textContent = "Booting WASM Environment...";
    progressFill.style.width = "30%";
    progressPct.textContent = "30%";
  } else if (status === 'writing') {
    statusText.textContent = "Mounting video file...";
    progressFill.style.width = "40%";
    progressPct.textContent = "40%";
  } else if (status === 'converting') {
    statusText.textContent = "Extracting audio...";
    progressFill.style.width = "50%";
    progressPct.textContent = "50%";
  } else if (status === 'progress_log') {
    // Parse FFmpeg stdout streams in real-time to compute conversion percentage
    // e.g. "  Duration: 00:03:45.00" -> video length
    // e.g. "frame=  222 ... time=00:01:30.00" -> current position
    if (log.includes("Duration:")) {
      const match = log.match(/Duration:\s*(\d{2}:\d{2}:\d{2}\.\d{2})/);
      if (match) {
        videoDuration = parseTimeToSeconds(match[1]);
      }
    } else if (log.includes("time=") && videoDuration > 0) {
      const match = log.match(/time=\s*(\d{2}:\d{2}:\d{2}\.\d{2})/);
      if (match) {
        const currentTime = parseTimeToSeconds(match[1]);
        const progress = (currentTime / videoDuration);
        const pct = Math.min(98, Math.round(50 + progress * 48));
        progressFill.style.width = `${pct}%`;
        progressPct.textContent = `${pct}%`;
      }
    }
  } else if (status === 'reading') {
    statusText.textContent = "Reclaiming output stream...";
    progressFill.style.width = "99%";
    progressPct.textContent = "99%";
  } else if (status === 'done') {
    statusText.textContent = "Downloading MP3...";
    progressFill.style.width = "100%";
    progressPct.textContent = "100%";
    
    // Save file locally
    const blob = new Blob([mp3Data], { type: "audio/mp3" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    a.click();
    
    // Release URL resources
    URL.revokeObjectURL(url);
    
    statusText.textContent = "Conversion Complete!";
    setTimeout(() => {
      progressContainer.classList.add("hidden");
      convertBtn.disabled = false;
    }, 4000);
  } else if (status === 'error') {
    console.error("Sandbox conversion error:", message);
    statusText.textContent = `Error: ${message}`;
    statusText.style.color = "#ef4444";
    convertBtn.disabled = false;
  }
});

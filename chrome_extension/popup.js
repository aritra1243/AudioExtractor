let selectedFile = null;
let downloadHandled = false; // Prevent duplicate download triggers

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

// ── Restore State on Open ───────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  chrome.runtime.sendMessage({ action: 'getStatus' }, (response) => {
    if (response && response.status !== 'idle') {
      // Restore UI to converting state
      convertBtn.disabled = true;
      progressContainer.classList.remove("hidden");
      updateUI(response);
    }
  });
});

// ── Listen for Updates from Background Worker ────────────────────────────────
chrome.runtime.onMessage.addListener((message) => {
  if (message.action === 'statusChanged') {
    updateUI(message);
  }
});

// Update progress bar and texts based on status state
async function updateUI(state) {
  const { status, ratio, fileName, error } = state;

  if (status === 'loading') {
    statusText.textContent = "Initializing WASM Engine...";
    progressFill.style.width = "10%";
    progressPct.textContent = "10%";
  } else if (status === 'writing') {
    statusText.textContent = "Mounting video file...";
    progressFill.style.width = "20%";
    progressPct.textContent = "20%";
  } else if (status === 'converting') {
    statusText.textContent = "Extracting audio...";
    const pct = Math.min(98, Math.round(30 + ratio * 65));
    progressFill.style.width = `${pct}%`;
    progressPct.textContent = `${pct}%`;
  } else if (status === 'reading') {
    statusText.textContent = "Reclaiming output stream...";
    progressFill.style.width = "99%";
    progressPct.textContent = "99%";
  } else if (status === 'done') {
    if (downloadHandled) return; // Already handled this conversion's download
    downloadHandled = true;

    statusText.textContent = "Downloading MP3...";
    progressFill.style.width = "100%";
    progressPct.textContent = "100%";

    try {
      // 1. Retrieve the finished MP3 ArrayBuffer from the shared IndexedDB
      const mp3Buffer = await getFile('output_mp3');
      if (mp3Buffer) {
        // 2. Trigger local download in user browser
        const blob = new Blob([mp3Buffer], { type: "audio/mp3" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = fileName;
        a.click();
        URL.revokeObjectURL(url);
      }
    } catch (err) {
      console.error("Failed to fetch output from db:", err);
    } finally {
      // 3. Clear database files to free disk space
      await deleteFile('input_video').catch(() => {});
      await deleteFile('output_mp3').catch(() => {});

      // 4. Reset status back to idle
      chrome.runtime.sendMessage({ action: 'updateStatus', status: 'idle' });
      
      statusText.textContent = "Conversion Complete!";
      setTimeout(() => {
        progressContainer.classList.add("hidden");
        convertBtn.disabled = selectedFile === null;
      }, 4000);
    }
  } else if (status === 'error') {
    statusText.textContent = `Error: ${error}`;
    statusText.style.color = "#ef4444";
    
    // Clear databases
    await deleteFile('input_video').catch(() => {});
    await deleteFile('output_mp3').catch(() => {});
    
    setTimeout(() => {
      progressContainer.classList.add("hidden");
      convertBtn.disabled = selectedFile === null;
      statusText.style.color = "var(--text-dim)";
    }, 5000);
  }
}

// ── File Upload / Drag & Drop ───────────────────────────────────────────────
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

// ── Convert Event ────────────────────────────────────────────────────────────
convertBtn.addEventListener("click", () => {
  if (!selectedFile) return;

  convertBtn.disabled = true;
  progressContainer.classList.remove("hidden");
  downloadHandled = false; // Reset for new conversion
  
  statusText.textContent = "Loading file locally...";
  progressFill.style.width = "5%";
  progressPct.textContent = "5%";

  // Read video file as ArrayBuffer
  const reader = new FileReader();
  reader.onload = async function(e) {
    try {
      const arrayBuffer = e.target.result;
      
      // Save input file to local IndexedDB store
      await setFile('input_video', arrayBuffer);
      
      // Notify background script to spawn the offscreen document and start transcode
      chrome.runtime.sendMessage({
        action: 'startConvert',
        fileName: selectedFile.name
      });
      
    } catch (err) {
      statusText.textContent = `Error: ${err.message || err}`;
      statusText.style.color = "#ef4444";
      convertBtn.disabled = false;
    }
  };
  
  reader.onerror = function() {
    statusText.textContent = "Error reading video file.";
    statusText.style.color = "#ef4444";
    convertBtn.disabled = false;
  };

  reader.readAsArrayBuffer(selectedFile);
});

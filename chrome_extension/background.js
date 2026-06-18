// Cache to hold status so the popup can fetch it when reopened
let currentStatus = {
  status: 'idle', // 'idle', 'loading', 'writing', 'converting', 'reading', 'done', 'error'
  ratio: 0,
  fileName: '',
  error: '',
  videoDuration: 0
};

// Helper to convert time format (HH:MM:SS.ms) to seconds
function parseTimeToSeconds(timeStr) {
  const parts = timeStr.trim().split(":");
  if (parts.length !== 3) return 0;
  const hrs = parseFloat(parts[0]);
  const mins = parseFloat(parts[1]);
  const secs = parseFloat(parts[2]);
  return (hrs * 3600) + (mins * 60) + secs;
}

// Handle runtime messages
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'getStatus') {
    sendResponse(currentStatus);
    return true;
  }

  else if (message.action === 'startConvert') {
    currentStatus = {
      status: 'loading',
      ratio: 0,
      fileName: message.fileName,
      error: '',
      videoDuration: 0
    };
    startOffscreenConversion(message.fileName);
  }

  else if (message.action === 'updateStatus') {
    if (message.status === 'idle') {
      // Popup signals it has handled the result – reset state
      currentStatus = { status: 'idle', ratio: 0, fileName: '', error: '', videoDuration: 0 };
    } else {
      currentStatus.status = message.status;
      if (message.status === 'done') {
        currentStatus.fileName = message.fileName;
        // Delay closing so popup can fetch the result from IndexedDB
        setTimeout(() => closeOffscreen(), 3000);
      } else if (message.status === 'error') {
        currentStatus.error = message.message;
        setTimeout(() => closeOffscreen(), 2000);
      }
      // Broadcast status to popup if it's currently open
      chrome.runtime.sendMessage({ action: 'statusChanged', ...currentStatus }).catch(() => {});
    }
  }

  else if (message.action === 'duration') {
    currentStatus.videoDuration = parseTimeToSeconds(message.duration);
  }

  else if (message.action === 'progressTime' && currentStatus.videoDuration > 0) {
    const currentTime = parseTimeToSeconds(message.time);
    currentStatus.ratio = Math.min(1, currentTime / currentStatus.videoDuration);
    // Broadcast real-time progress update to popup
    chrome.runtime.sendMessage({ action: 'statusChanged', ...currentStatus }).catch(() => {});
  }
});

// Setup and boot the Offscreen Document context
async function startOffscreenConversion(fileName) {
  try {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT']
    });

    if (contexts.length === 0) {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['WORKERS'],
        justification: 'Transcode video to MP3 audio in background using WebAssembly'
      });
    }

    // Retry sending to the offscreen document until it responds (it needs time to initialize)
    let attempts = 0;
    const maxAttempts = 20;
    const tryDeliver = () => {
      chrome.runtime.sendMessage({ action: 'startOffscreenConvert', fileName })
        .catch((e) => {
          attempts++;
          if (attempts < maxAttempts) {
            setTimeout(tryDeliver, 200);
          } else {
            console.error("Failed to reach offscreen document after retries:", e);
            currentStatus.status = 'error';
            currentStatus.error = 'Offscreen document did not respond.';
            chrome.runtime.sendMessage({ action: 'statusChanged', ...currentStatus }).catch(() => {});
          }
        });
    };

    // Small initial delay to let offscreen.html load its scripts
    setTimeout(tryDeliver, 300);
  } catch (err) {
    console.error("Failed to create offscreen document:", err);
    currentStatus.status = 'error';
    currentStatus.error = err.message;
    chrome.runtime.sendMessage({ action: 'statusChanged', ...currentStatus }).catch(() => {});
  }
}

async function closeOffscreen() {
  try {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT']
    });
    if (contexts.length > 0) {
      await chrome.offscreen.closeDocument();
    }
  } catch (e) {
    console.warn("Could not close offscreen document:", e);
  }
}

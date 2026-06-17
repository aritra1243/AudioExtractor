/* ─── AudioExtractor Frontend Logic ──────────────────────── */

const STEM_META = {
  vocals: { emoji: '🎤', label: 'Lead vocals & harmonies', color: '#a78bfa', effectLabel: 'Voice Conversion' },
  drums:  { emoji: '🥁', label: 'Kick, snare & percussion', color: '#fbbf24', effectLabel: 'Beat Style' },
  bass:   { emoji: '🎸', label: 'Bass guitar & sub-bass',  color: '#34d399', effectLabel: 'Instrument Key' },
  other:  { emoji: '🎹', label: 'Guitars, keys & synths',  color: '#60a5fa', effectLabel: 'Instrument Key' },
};

// ── DOM refs ──────────────────────────────────────────────────────────────────
const uploadZone        = document.getElementById('upload-zone');
const fileInput         = document.getElementById('file-input');
const uploadSection     = document.getElementById('upload-section');
const processingSection = document.getElementById('processing-section');
const resultsSection    = document.getElementById('results-section');
const stemsGrid         = document.getElementById('stems-grid');
const progressFill      = document.getElementById('progress-fill');
const progressPct       = document.getElementById('progress-pct');
const processingMsg     = document.getElementById('processing-msg');
const newSongBtn        = document.getElementById('new-song-btn');
const cancelBtn         = document.getElementById('cancel-btn');
const elapsedEl         = document.getElementById('elapsed-time');
const errorToast        = document.getElementById('error-toast');
const errorMsg          = document.getElementById('error-msg');
const toastClose        = document.getElementById('toast-close');

let currentJobId  = null;
let pollTimer     = null;   // setInterval handle — replaces SSE
let elapsedTimer  = null;   // elapsed time counter
let elapsedSecs   = 0;
// Track the currently active audio URL per stem (for download)
const stemActiveUrl = {};

// ── Drag & drop ───────────────────────────────────────────────────────────────
['dragenter', 'dragover'].forEach(evt =>
  uploadZone.addEventListener(evt, e => { e.preventDefault(); uploadZone.classList.add('drag-over'); })
);
['dragleave', 'dragend', 'drop'].forEach(evt =>
  uploadZone.addEventListener(evt, e => { e.preventDefault(); uploadZone.classList.remove('drag-over'); })
);
uploadZone.addEventListener('drop', e => {
  const file = e.dataTransfer?.files?.[0];
  if (file) startUpload(file);
});

uploadZone.addEventListener('click', e => {
  if (e.target.tagName !== 'LABEL' && e.target.tagName !== 'INPUT') fileInput.click();
});
uploadZone.addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
});
fileInput.addEventListener('change', () => { if (fileInput.files[0]) startUpload(fileInput.files[0]); });

// ── Upload & separate ─────────────────────────────────────────────────────────
async function startUpload(file) {
  hideError();
  if (file.size > 150 * 1024 * 1024) { showError('File too large. Max 150 MB.'); return; }

  const ext = file.name.split('.').pop().toLowerCase();
  const ok  = ['mp3','wav','flac','ogg','m4a','aac','wma'];
  if (!ok.includes(ext)) { showError(`Unsupported format: .${ext}`); return; }

  showSection('processing');
  setProgress(2, 'Uploading file…');
  startElapsed();

  const formData = new FormData();
  formData.append('file', file);

  let jobId;
  try {
    const res  = await fetch('/upload', { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || 'Upload failed');
    jobId = data.job_id;
  } catch (err) {
    showError(err.message);
    stopElapsed();
    showSection('upload');
    return;
  }

  currentJobId = jobId;
  startPolling(jobId);
}

// ── Polling (replaces SSE — immune to server restarts & debug reloader) ───────
function startPolling(jobId) {
  stopPolling();   // clear any previous timer
  pollTimer = setInterval(() => pollOnce(jobId), 1000);
}

function stopPolling() {
  if (pollTimer !== null) { clearInterval(pollTimer); pollTimer = null; }
}

// ── Elapsed time counter ──────────────────────────────────────────────────────
function startElapsed() {
  stopElapsed();
  elapsedSecs = 0;
  elapsedEl.textContent = '0:00';
  elapsedTimer = setInterval(() => {
    elapsedSecs++;
    const m = Math.floor(elapsedSecs / 60);
    const s = String(elapsedSecs % 60).padStart(2, '0');
    elapsedEl.textContent = `${m}:${s}`;
  }, 1000);
}

function stopElapsed() {
  if (elapsedTimer !== null) { clearInterval(elapsedTimer); elapsedTimer = null; }
}

async function pollOnce(jobId) {
  // If user navigated away (New Song), stop
  if (currentJobId !== jobId) { stopPolling(); return; }

  let job;
  try {
    const res = await fetch(`/status/${jobId}`);
    if (!res.ok) return;          // server momentarily unavailable — just retry
    job = await res.json();
  } catch {
    return;                       // network glitch — keep polling silently
  }

  if (job.status === 'done') {
    stopPolling();
    stopElapsed();
    setProgress(100, 'Done!');
    setTimeout(() => showResults(jobId, job.stems), 600);
    return;
  }
  if (job.status === 'error') {
    stopPolling();
    stopElapsed();
    showError(job.message || 'Separation failed.');
    showSection('upload');
    return;
  }
  // Still processing — update progress bar
  setProgress(job.progress || 0, job.message || 'Processing…');
}

// ── Build results grid ────────────────────────────────────────────────────────
async function showResults(jobId, stems) {
  stemsGrid.innerHTML = '';
  const order = ['vocals', 'drums', 'bass', 'other'];

  for (const stem of order) {
    if (!stems[stem]) continue;

    const meta       = STEM_META[stem];
    const streamUrl  = `/download/${jobId}/${stem}`;
    const dlUrl      = `/download/${jobId}/${stem}?dl=1`;
    stemActiveUrl[stem] = { stream: streamUrl, dl: dlUrl };

    // Fetch presets for this stem from server
    let presetOptions = [];
    try {
      const res = await fetch(`/presets/${stem}`);
      presetOptions = await res.json();
    } catch { /* fallback: empty */ }

    const optionsHtml = presetOptions.map(p =>
      `<option value="${p.key}">${p.label}</option>`
    ).join('');

    const card = document.createElement('div');
    card.className = 'stem-card';
    card.dataset.stem = stem;
    card.dataset.jobId = jobId;

    card.innerHTML = `
      <div class="stem-header">
        <span class="stem-emoji">${meta.emoji}</span>
        <div class="stem-info">
          <div class="stem-name">${stem === 'other' ? 'Instruments' : stem.charAt(0).toUpperCase() + stem.slice(1)}</div>
          <div class="stem-label">${meta.label}</div>
        </div>
      </div>

      <audio class="stem-audio" id="audio-${stem}" controls preload="none" src="${streamUrl}"></audio>

      <div class="effect-panel">
        <label class="effect-label" for="preset-${stem}">${meta.effectLabel}</label>
        <div class="effect-row">
          <select class="effect-select" id="preset-${stem}" data-stem="${stem}" aria-label="${meta.effectLabel}">
            ${optionsHtml}
          </select>
          <button class="btn-apply" id="apply-${stem}" data-stem="${stem}" aria-label="Apply effect to ${stem}">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M2 8l4 4 8-8" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
            Apply
          </button>
        </div>
        <div class="effect-status hidden" id="effect-status-${stem}"></div>
      </div>

      <div class="stem-actions">
        <a class="btn-download" id="dl-${stem}" href="${dlUrl}" download="${stem}.mp3">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M8 1v9M4 6l4 4 4-4M2 14h12" stroke="currentColor" stroke-width="2"
                  stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          Download
        </a>
      </div>
    `;
    stemsGrid.appendChild(card);

    // Wire up Apply button
    card.querySelector(`#apply-${stem}`).addEventListener('click', () => applyEffect(stem, jobId));
  }

  showSection('results');
}

// ── Apply effect ──────────────────────────────────────────────────────────────
async function applyEffect(stem, jobId) {
  const select    = document.getElementById(`preset-${stem}`);
  const applyBtn  = document.getElementById(`apply-${stem}`);
  const statusEl  = document.getElementById(`effect-status-${stem}`);
  const audioEl   = document.getElementById(`audio-${stem}`);
  const dlBtn     = document.getElementById(`dl-${stem}`);
  const preset    = select.value;

  // If "original" selected, restore original stem audio
  if (preset === 'original') {
    const orig = `/download/${jobId}/${stem}`;
    audioEl.src = orig;
    audioEl.load();
    dlBtn.href = `/download/${jobId}/${stem}?dl=1`;
    dlBtn.setAttribute('download', `${stem}.mp3`);
    stemActiveUrl[stem] = { stream: orig, dl: `/download/${jobId}/${stem}?dl=1` };
    showEffectStatus(statusEl, '✓ Restored original', 'success');
    return;
  }

  // Show loading state
  applyBtn.disabled = true;
  applyBtn.innerHTML = `<span class="spinner"></span> Processing…`;
  const loadingMsg = stem === 'vocals' ? 'Converting voice — please wait…' : 'Applying effect — please wait…';
  showEffectStatus(statusEl, loadingMsg, 'info');

  try {
    const res  = await fetch(`/transform/${jobId}/${stem}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preset }),
    });
    const data = await res.json();

    if (!res.ok || data.error) throw new Error(data.error || 'Transform failed');

    // Update audio player and download link
    const newStream = data.url;
    const newDl     = `${data.dl_url}&stem=${stem}`;
    audioEl.src = newStream;
    audioEl.load();
    audioEl.play().catch(() => {});

    dlBtn.href = newDl;
    dlBtn.setAttribute('download', stem === 'vocals' ? 'vocals_converted.wav' : `${stem}_transformed.wav`);
    stemActiveUrl[stem] = { stream: newStream, dl: newDl };

    const successMsg = stem === 'vocals' ? '✓ Voice converted! Press play to preview.' : '✓ Effect applied! Press play to preview.';
    showEffectStatus(statusEl, successMsg, 'success');
  } catch (err) {
    showEffectStatus(statusEl, `⚠ ${err.message}`, 'error');
  } finally {
    applyBtn.disabled = false;
    applyBtn.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M2 8l4 4 8-8" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      Apply`;
  }
}

function showEffectStatus(el, msg, type) {
  el.textContent = msg;
  el.className   = `effect-status effect-status--${type}`;
  el.classList.remove('hidden');
  clearTimeout(el._timer);
  if (type === 'success') {
    el._timer = setTimeout(() => el.classList.add('hidden'), 4000);
  }
}

// ── New song button ───────────────────────────────────────────────────────────
newSongBtn.addEventListener('click', () => {
  stopPolling();
  stopElapsed();
  currentJobId = null;
  fileInput.value = '';
  stemsGrid.innerHTML = '';
  setProgress(0, '');
  showSection('upload');
});

// Cancel button — goes back to upload, leaves job running server-side
cancelBtn.addEventListener('click', () => {
  stopPolling();
  stopElapsed();
  currentJobId = null;
  fileInput.value = '';
  setProgress(0, '');
  showSection('upload');
});

// ── Error toast ───────────────────────────────────────────────────────────────
function showError(msg) {
  errorMsg.textContent = msg;
  errorToast.classList.remove('hidden');
  clearTimeout(showError._timer);
  showError._timer = setTimeout(hideError, 6000);
}
function hideError() { errorToast.classList.add('hidden'); }
toastClose.addEventListener('click', hideError);

// ── Helpers ───────────────────────────────────────────────────────────────────
function setProgress(pct, msg) {
  progressFill.style.width = `${pct}%`;
  progressPct.textContent  = `${pct}%`;
  progressFill.closest('[role=progressbar]').setAttribute('aria-valuenow', pct);
  if (msg) processingMsg.textContent = msg;
}

function showSection(which) {
  uploadSection.classList.toggle('hidden',     which !== 'upload');
  processingSection.classList.toggle('hidden', which !== 'processing');
  resultsSection.classList.toggle('hidden',    which !== 'results');

  // Show OR divider + presep section only on the upload screen
  const orDivider    = document.getElementById('or-divider');
  const presepSection = document.getElementById('presep-section');
  if (orDivider)     orDivider.classList.toggle('hidden',     which !== 'upload');
  if (presepSection) presepSection.classList.toggle('hidden', which !== 'upload');

  // Show video divider and video converter section only on the upload screen
  const videoDivider = document.getElementById('video-divider');
  const videoSection = document.getElementById('video-converter-section');
  if (videoDivider) videoDivider.classList.toggle('hidden', which !== 'upload');
  if (videoSection) videoSection.classList.toggle('hidden', which !== 'upload');
}

// ── Pre-Separated Stems Section ───────────────────────────────────────────────
const PRESEP_STEMS  = ['vocals', 'drums', 'bass', 'other'];
const presepFiles   = {};   // stem → File object
const loadStemsBtn  = document.getElementById('load-stems-btn');
const presepNote    = document.getElementById('presep-note');
function _presepFileName(name) {
  return name.length > 22 ? name.slice(0, 19) + '…' : name;
}

function _updatePresepState() {
  const count = Object.keys(presepFiles).length;
  loadStemsBtn.disabled = count === 0;
  if (count === 0) {
    presepNote.textContent = 'Upload at least one stem file to continue.';
    presepNote.classList.remove('ready');
  } else {
    presepNote.textContent = `${count} stem${count > 1 ? 's' : ''} selected — ready to open editor.`;
    presepNote.classList.add('ready');
  }
}

// Wire file inputs + drag-drop for each stem drop zone
PRESEP_STEMS.forEach(stem => {
  const dropZone  = document.getElementById(`drop-${stem}`);
  const fileInput = document.getElementById(`psep-${stem}`);
  const nameEl    = document.getElementById(`psep-name-${stem}`);

  function handleFile(file) {
    if (!file) return;
    const ext = file.name.split('.').pop().toLowerCase();
    if (!['mp3','wav','flac','ogg','m4a','aac'].includes(ext)) {
      showError(`Unsupported format: .${ext}`);
      return;
    }
    presepFiles[stem] = file;
    dropZone.classList.add('has-file');
    nameEl.textContent = _presepFileName(file.name);
    nameEl.classList.remove('hidden');
    _updatePresepState();
  }

  // File input change
  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) handleFile(fileInput.files[0]);
  });

  // Drag events
  ['dragenter','dragover'].forEach(evt =>
    dropZone.addEventListener(evt, e => {
      e.preventDefault();
      dropZone.classList.add('drag-active');
    })
  );
  ['dragleave','dragend'].forEach(evt =>
    dropZone.addEventListener(evt, () => dropZone.classList.remove('drag-active'))
  );
  dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('drag-active');
    handleFile(e.dataTransfer?.files?.[0]);
  });
});

// ── Load Stems: upload files → jump straight to results editor ────────────────
loadStemsBtn.addEventListener('click', loadPreSepStems);

async function loadPreSepStems() {
  if (Object.keys(presepFiles).length === 0) return;

  // Disable button + show spinner
  loadStemsBtn.disabled = true;
  loadStemsBtn.innerHTML = `<span class="spinner"></span> Uploading…`;

  const formData = new FormData();
  for (const [stem, file] of Object.entries(presepFiles)) {
    formData.append(stem, file);
  }

  try {
    const res  = await fetch('/upload-stems', { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || 'Upload failed');

    currentJobId = data.job_id;
    // Jump straight to results — same flow as after AI separation
    await showResults(data.job_id, data.stems);
  } catch (err) {
    showError(err.message);
    loadStemsBtn.disabled = false;
    loadStemsBtn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M8 1v9M4 6l4 4 4-4M2 14h12" stroke="currentColor" stroke-width="2"
              stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      Load Stems &amp; Open Editor`;
  }
}


// ═══════════════════════════════════════════════════════
//  MIXER / MERGE EDITOR
// ═══════════════════════════════════════════════════════
const mixerSection  = document.getElementById('mixer-section');
const mixerTracks   = document.getElementById('mixer-tracks');
const mergeBtn      = document.getElementById('merge-btn');
const mixerClose    = document.getElementById('mixer-close');
const mixPlayBtn    = document.getElementById('mix-play-btn');
const mixStopBtn    = document.getElementById('mix-stop-btn');
const mixTimeEl     = document.getElementById('mix-time');
const mixerProgress = document.getElementById('mixer-progress');
const mixerHead     = document.getElementById('mixer-head');
const masterVolEl   = document.getElementById('master-vol');
const masterVolVal  = document.getElementById('master-vol-val');
const renderBtn     = document.getElementById('render-btn');
const renderStatus  = document.getElementById('render-status');

// Per-stem state: { volume:100, pan:0, muted:false, soloed:false }
const mixState    = {};
let   mixJobId    = null;
let   audioCtx    = null;
let   mixSources  = {};   // stem → AudioBufferSourceNode
let   mixGains    = {};   // stem → GainNode
let   mixPanners  = {};   // stem → StereoPannerNode
let   masterGain  = null;
let   mixDuration = 0;
let   mixStartTime= 0;
let   mixOffset   = 0;
let   isPlaying   = false;
let   rafId       = null;
let   mixBuffers  = {};   // stem → AudioBuffer (cached)

const STEM_COLORS = {
  vocals: '#a78bfa', drums: '#fbbf24', bass: '#34d399', other: '#60a5fa'
};
const STEM_EMOJI = { vocals:'🎤', drums:'🥁', bass:'🎸', other:'🎹' };
const STEM_LABELS = { vocals:'Vocals', drums:'Drums', bass:'Bass', other:'Instruments' };

// ── Open / close mixer ────────────────────────────────────────────────────────
mergeBtn.addEventListener('click', () => {
  const isOpen = !mixerSection.classList.contains('hidden');
  if (isOpen) {
    closeMixer();
  } else {
    openMixer();
  }
});
mixerClose.addEventListener('click', closeMixer);

function openMixer() {
  mixerSection.classList.remove('hidden');
  mergeBtn.classList.add('active');
  mixerSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  buildMixerTracks();
}
function closeMixer() {
  stopMix();
  mixerSection.classList.add('hidden');
  mergeBtn.classList.remove('active');
}

// ── Build track rows ──────────────────────────────────────────────────────────
function buildMixerTracks() {
  mixerTracks.innerHTML = '';
  const order = ['vocals', 'drums', 'bass', 'other'];

  // Get current available stems from stemActiveUrl
  const available = order.filter(s => stemActiveUrl[s]);
  if (available.length === 0) {
    mixerTracks.innerHTML = '<p style="color:var(--text-muted);padding:12px 0">No stems loaded yet.</p>';
    return;
  }

  available.forEach(stem => {
    if (!mixState[stem]) {
      mixState[stem] = { volume: 100, pan: 0, muted: false, soloed: false };
    }
    const st = mixState[stem];
    const color = STEM_COLORS[stem] || 'var(--purple)';

    // Generate random-looking waveform bars (seed from stem name)
    const bars = Array.from({ length: 32 }, (_, i) => {
      const h = 20 + Math.abs(Math.sin(i * 0.7 + stem.charCodeAt(0)) * 28) + Math.random() * 10;
      return `<div class="wv-bar" style="height:${h.toFixed(0)}px"></div>`;
    }).join('');

    const row = document.createElement('div');
    row.className = 'mix-track' + (st.muted ? ' muted' : '') + (st.soloed ? ' soloed' : '');
    row.dataset.stem = stem;
    row.innerHTML = `
      <div class="track-left">
        <span class="track-emoji">${STEM_EMOJI[stem]}</span>
        <div class="track-info">
          <div class="track-name" style="color:${color}">${STEM_LABELS[stem]}</div>
          <div class="track-vol-label" id="vl-${stem}">${st.volume}%</div>
        </div>
        <div class="track-btns">
          <button class="track-btn ${st.muted  ? 'mute-on' : ''}" id="mute-${stem}"  title="Mute">M</button>
          <button class="track-btn ${st.soloed ? 'solo-on' : ''}" id="solo-${stem}"  title="Solo">S</button>
        </div>
      </div>
      <div class="track-center">
        <div class="track-waveform">${bars}</div>
        <input type="range" class="track-vol-slider" id="vol-${stem}"
               min="0" max="200" value="${st.volume}"
               style="--track-color:${color}" title="Volume" />
      </div>
      <div class="track-right">
        <span class="track-pan-label">Pan</span>
        <input type="range" class="track-pan-slider" id="pan-${stem}"
               min="-100" max="100" value="${st.pan}"
               style="--track-color:${color}" title="Pan" />
        <span class="track-pan-val" id="pv-${stem}">${_panLabel(st.pan)}</span>
      </div>
    `;
    mixerTracks.appendChild(row);

    // Volume slider
    row.querySelector(`#vol-${stem}`).addEventListener('input', e => {
      mixState[stem].volume = +e.target.value;
      document.getElementById(`vl-${stem}`).textContent = `${mixState[stem].volume}%`;
      _applyGain(stem);
    });

    // Pan slider
    row.querySelector(`#pan-${stem}`).addEventListener('input', e => {
      mixState[stem].pan = +e.target.value;
      document.getElementById(`pv-${stem}`).textContent = _panLabel(mixState[stem].pan);
      _applyPan(stem);
    });

    // Mute button
    row.querySelector(`#mute-${stem}`).addEventListener('click', () => {
      mixState[stem].muted = !mixState[stem].muted;
      row.classList.toggle('muted', mixState[stem].muted);
      row.querySelector(`#mute-${stem}`).classList.toggle('mute-on', mixState[stem].muted);
      _applyGain(stem);
    });

    // Solo button
    row.querySelector(`#solo-${stem}`).addEventListener('click', () => {
      mixState[stem].soloed = !mixState[stem].soloed;
      row.classList.toggle('soloed', mixState[stem].soloed);
      row.querySelector(`#solo-${stem}`).classList.toggle('solo-on', mixState[stem].soloed);
      // If any track is soloed, mute all non-soloed tracks in the audio graph
      _updateSolo();
    });
  });
}

function _panLabel(v) {
  if (v === 0) return 'C';
  return v < 0 ? `L${Math.abs(v)}` : `R${v}`;
}

// ── Master volume ─────────────────────────────────────────────────────────────
masterVolEl.addEventListener('input', () => {
  const v = +masterVolEl.value;
  masterVolVal.textContent = `${v}%`;
  if (masterGain) masterGain.gain.value = v / 100;
});

// ── Web Audio live preview ────────────────────────────────────────────────────
mixPlayBtn.addEventListener('click', async () => {
  if (isPlaying) { pauseMix(); return; }
  await startMix();
});
mixStopBtn.addEventListener('click', stopMix);

async function startMix() {
  // Collect stem URLs
  const order = ['vocals','drums','bass','other'];
  const toLoad = order.filter(s => stemActiveUrl[s] && !mixState[s]?.muted);

  if (toLoad.length === 0) { showError('All tracks are muted.'); return; }

  mixPlayBtn.classList.add('playing');
  renderStatus.textContent = 'Loading audio for preview…';
  renderStatus.parentElement.className = 'mixer-footer-info working';

  // Lazy init AudioContext
  if (!audioCtx || audioCtx.state === 'closed') {
    audioCtx  = new (window.AudioContext || window.webkitAudioContext)();
    masterGain = audioCtx.createGain();
    masterGain.gain.value = +masterVolEl.value / 100;
    masterGain.connect(audioCtx.destination);
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();

  // Load & decode buffers
  let maxDur = 0;
  for (const stem of order) {
    if (!stemActiveUrl[stem]) continue;
    if (!mixBuffers[stem]) {
      try {
        const url  = stemActiveUrl[stem].stream;
        const resp = await fetch(url);
        const ab   = await resp.arrayBuffer();
        mixBuffers[stem] = await audioCtx.decodeAudioData(ab);
      } catch { continue; }
    }
    if (mixBuffers[stem] && mixBuffers[stem].duration > maxDur)
      maxDur = mixBuffers[stem].duration;
  }

  mixDuration = maxDur;
  _startSources(mixOffset);
}

function _startSources(offset = 0) {
  // Clear old sources
  Object.values(mixSources).forEach(s => { try { s.stop(); } catch {} });
  mixSources = {}; mixGains = {}; mixPanners = {};

  const order = ['vocals','drums','bass','other'];
  order.forEach(stem => {
    const buf = mixBuffers[stem];
    if (!buf || !stemActiveUrl[stem]) return;

    const gainNode   = audioCtx.createGain();
    const pannerNode = audioCtx.createStereoPanner
      ? audioCtx.createStereoPanner()
      : { pan: { value: 0 }, connect: n => gainNode.connect(n) };

    const st = mixState[stem] || { volume: 100, pan: 0, muted: false, soloed: false };
    gainNode.gain.value = _effectiveGain(stem);
    if (pannerNode.pan) pannerNode.pan.value = st.pan / 100;

    const src = audioCtx.createBufferSource();
    src.buffer = buf;

    if (pannerNode.connect) {
      src.connect(gainNode);
      gainNode.connect(pannerNode);
      pannerNode.connect(masterGain);
    } else {
      src.connect(gainNode);
      gainNode.connect(masterGain);
    }

    src.start(0, offset);
    src.onended = () => { if (stem === order[0]) stopMix(); };

    mixSources[stem]  = src;
    mixGains[stem]    = gainNode;
    mixPanners[stem]  = pannerNode;
  });

  mixStartTime = audioCtx.currentTime - offset;
  isPlaying = true;
  _animatePlayhead();

  renderStatus.textContent = '▶ Playing preview…';
  renderStatus.parentElement.className = 'mixer-footer-info ready';
}

function pauseMix() {
  if (!isPlaying) return;
  mixOffset = audioCtx.currentTime - mixStartTime;
  Object.values(mixSources).forEach(s => { try { s.stop(); } catch {} });
  isPlaying = false;
  mixPlayBtn.classList.remove('playing');
  cancelAnimationFrame(rafId);
}

function stopMix() {
  Object.values(mixSources).forEach(s => { try { s.stop(); } catch {} });
  isPlaying = false;
  mixOffset = 0;
  mixPlayBtn.classList.remove('playing');
  cancelAnimationFrame(rafId);
  _setPlayhead(0);
  mixTimeEl.textContent = '0:00';
  renderStatus.textContent = 'Adjust the mix above, then render.';
  renderStatus.parentElement.className = 'mixer-footer-info';
}

function _animatePlayhead() {
  if (!isPlaying) return;
  const elapsed  = audioCtx.currentTime - mixStartTime;
  const pct      = mixDuration > 0 ? Math.min(elapsed / mixDuration, 1) : 0;
  _setPlayhead(pct);
  const m = Math.floor(elapsed / 60), s = Math.floor(elapsed % 60);
  mixTimeEl.textContent = `${m}:${String(s).padStart(2,'0')}`;
  if (pct < 1) rafId = requestAnimationFrame(_animatePlayhead);
  else stopMix();
}

function _setPlayhead(pct) {
  const p = (pct * 100).toFixed(1);
  mixerProgress.style.width = `${p}%`;
  mixerHead.style.left      = `${p}%`;
}

// Seek on click timeline
document.getElementById('mixer-timeline').addEventListener('click', e => {
  const bar  = e.currentTarget;
  const pct  = e.offsetX / bar.offsetWidth;
  mixOffset  = pct * mixDuration;
  _setPlayhead(pct);
  const m = Math.floor(mixOffset/60), s = Math.floor(mixOffset%60);
  mixTimeEl.textContent = `${m}:${String(s).padStart(2,'0')}`;
  if (isPlaying) { pauseMix(); startMix(); }
});

// ── Gain / pan helpers ────────────────────────────────────────────────────────
function _effectiveGain(stem) {
  const st = mixState[stem] || {};
  const anySoloed = Object.values(mixState).some(s => s.soloed);
  if (st.muted) return 0;
  if (anySoloed && !st.soloed) return 0;
  return (st.volume ?? 100) / 100;
}
function _applyGain(stem) {
  if (mixGains[stem]) mixGains[stem].gain.setTargetAtTime(_effectiveGain(stem), audioCtx.currentTime, 0.02);
}
function _applyPan(stem) {
  if (mixPanners[stem]?.pan) mixPanners[stem].pan.setTargetAtTime(mixState[stem].pan / 100, audioCtx.currentTime, 0.02);
}
function _updateSolo() {
  ['vocals','drums','bass','other'].forEach(s => _applyGain(s));
}

// ── Render & Download via backend ─────────────────────────────────────────────
renderBtn.addEventListener('click', async () => {
  if (!currentJobId) { showError('No job loaded.'); return; }

  renderBtn.disabled = true;
  renderBtn.innerHTML = `<span class="spinner"></span> Rendering…`;
  renderStatus.textContent = '⏳ Rendering merged WAV — please wait…';
  renderStatus.parentElement.className = 'mixer-footer-info working';

  const tracks = {};
  ['vocals','drums','bass','other'].forEach(stem => {
    if (mixState[stem]) {
      tracks[stem] = {
        volume: mixState[stem].volume,
        pan:    mixState[stem].pan,
        muted:  mixState[stem].muted,
      };
    }
  });

  try {
    const res  = await fetch(`/merge/${currentJobId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tracks, master_volume: +masterVolEl.value }),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || 'Render failed');

    renderStatus.textContent = '✓ Merged! Downloading…';
    renderStatus.parentElement.className = 'mixer-footer-info ready';

    // Auto-download
    const a = document.createElement('a');
    a.href     = data.dl_url;
    a.download = 'merged_mix.wav';
    document.body.appendChild(a);
    a.click();
    a.remove();
  } catch (err) {
    renderStatus.textContent = `⚠ ${err.message}`;
    renderStatus.parentElement.className = 'mixer-footer-info error';
  } finally {
    renderBtn.disabled = false;
    renderBtn.innerHTML = `
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
        <path d="M8 1v9M4 6l4 4 4-4M2 14h12" stroke="currentColor" stroke-width="2"
              stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      Render &amp; Download Mixed WAV`;
  }
});

// ═══════════════════════════════════════════════════════
//  VIDEO TO MP3 CONVERTER
// ═══════════════════════════════════════════════════════
const videoDropZone        = document.getElementById('video-drop-zone');
const videoFileInput         = document.getElementById('video-file-input');
const videoStatusContainer   = document.getElementById('video-status-container');
const videoSelectedName      = document.getElementById('video-selected-name');
const videoSelectedSize      = document.getElementById('video-selected-size');
const btnVideoRemove         = document.getElementById('btn-video-remove');
const videoProgressWrap      = document.getElementById('video-progress-wrap');
const videoProgressStatus    = document.getElementById('video-progress-status');
const videoProgressPct       = document.getElementById('video-progress-pct');
const videoProgressFill      = document.getElementById('video-progress-fill');
const videoResultWrap        = document.getElementById('video-result-wrap');
const videoAudioPreview      = document.getElementById('video-audio-preview');
const videoDownloadBtn       = document.getElementById('video-download-btn');
const videoConvertAnotherBtn = document.getElementById('video-convert-another-btn');

let videoUploadId = null;
let videoJobPollingTimer = null;
let currentVideoFile = null;

// Drag & drop handlers
if (videoDropZone) {
  ['dragenter', 'dragover'].forEach(evt =>
    videoDropZone.addEventListener(evt, e => {
      e.preventDefault();
      videoDropZone.classList.add('drag-active');
    })
  );
  ['dragleave', 'dragend', 'drop'].forEach(evt =>
    videoDropZone.addEventListener(evt, e => {
      e.preventDefault();
      videoDropZone.classList.remove('drag-active');
    })
  );
  videoDropZone.addEventListener('drop', e => {
    const file = e.dataTransfer?.files?.[0];
    if (file) handleVideoFileSelection(file);
  });
  videoDropZone.addEventListener('click', e => {
    if (e.target.tagName !== 'LABEL' && e.target.tagName !== 'INPUT') {
      videoFileInput.click();
    }
  });
}

if (videoFileInput) {
  videoFileInput.addEventListener('change', () => {
    if (videoFileInput.files[0]) handleVideoFileSelection(videoFileInput.files[0]);
  });
}

function formatSize(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function handleVideoFileSelection(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  const validExtensions = ['mp4', 'mkv', 'avi', 'mov', 'flv', 'webm', 'wmv'];
  if (!validExtensions.includes(ext)) {
    showError(`Unsupported video format: .${ext}. Use MP4, MKV, AVI, MOV, FLV, WEBM, or WMV.`);
    return;
  }
  
  currentVideoFile = file;
  
  // Show file info, hide drop zone
  videoDropZone.classList.add('hidden');
  videoStatusContainer.classList.remove('hidden');
  
  videoSelectedName.textContent = file.name;
  videoSelectedSize.textContent = formatSize(file.size);
  
  // Reset elements
  videoProgressWrap.classList.add('hidden');
  videoResultWrap.classList.add('hidden');
  btnVideoRemove.disabled = false;
  btnVideoRemove.classList.remove('hidden');
  
  // Automatically trigger chunked upload
  startChunkedVideoUpload(file);
}

// Remove button handler
if (btnVideoRemove) {
  btnVideoRemove.addEventListener('click', () => {
    cancelVideoProcess();
  });
}

function cancelVideoProcess() {
  stopVideoJobPolling();
  videoUploadId = null;
  currentVideoFile = null;
  if (videoFileInput) videoFileInput.value = '';
  
  videoStatusContainer.classList.add('hidden');
  videoDropZone.classList.remove('hidden');
}

// Chunked upload implementation
async function startChunkedVideoUpload(file) {
  const CHUNK_SIZE = 5 * 1024 * 1024; // 5MB chunks
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
  videoUploadId = Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
  
  videoProgressWrap.classList.remove('hidden');
  btnVideoRemove.disabled = true; // disable removal during active upload
  btnVideoRemove.classList.add('hidden');
  
  setVideoProgress(0, 'Preparing upload...');
  
  for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
    const start = chunkIndex * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, file.size);
    const chunk = file.slice(start, end);
    
    const formData = new FormData();
    formData.append('chunk', chunk);
    formData.append('upload_id', videoUploadId);
    formData.append('chunk_index', chunkIndex);
    formData.append('total_chunks', totalChunks);
    formData.append('filename', file.name);
    
    // Calculate current progress base percentage
    const basePct = Math.round((chunkIndex / totalChunks) * 100);
    setVideoProgress(basePct, `Uploading: chunk ${chunkIndex + 1}/${totalChunks}...`);
    
    try {
      const res = await fetch('/video-converter/upload-chunk', {
        method: 'POST',
        body: formData
      });
      const data = await res.json();
      
      if (!res.ok || data.error) {
        throw new Error(data.error || 'Upload failed');
      }
      
      if (data.upload_complete && data.job_id) {
        // Chunk upload completed, start polling conversion status
        setVideoProgress(100, 'Processing audio conversion...');
        startVideoJobPolling(data.job_id);
        return;
      }
    } catch (err) {
      showError(`Video upload failed: ${err.message}`);
      cancelVideoProcess();
      return;
    }
  }
}

function setVideoProgress(pct, msg) {
  videoProgressFill.style.width = `${pct}%`;
  videoProgressPct.textContent = `${pct}%`;
  videoProgressStatus.textContent = msg;
}

function startVideoJobPolling(jobId) {
  stopVideoJobPolling();
  // Poll every 1 second
  videoJobPollingTimer = setInterval(() => pollVideoJobOnce(jobId), 1000);
}

function stopVideoJobPolling() {
  if (videoJobPollingTimer !== null) {
    clearInterval(videoJobPollingTimer);
    videoJobPollingTimer = null;
  }
}

async function pollVideoJobOnce(jobId) {
  try {
    const res = await fetch(`/video-converter/status/${jobId}`);
    if (!res.ok) return;
    const job = await res.json();
    
    if (job.status === 'done') {
      stopVideoJobPolling();
      setVideoProgress(100, 'Done!');
      
      // Configure Result Area
      const downloadName = currentVideoFile ? currentVideoFile.name.replace(/\.[^/.]+$/, "") + '.mp3' : 'audio.mp3';
      const downloadUrl = `/video-converter/download/${job.output_filename}?dl=1&name=${encodeURIComponent(downloadName)}`;
      const streamUrl = `/video-converter/download/${job.output_filename}`;
      
      videoAudioPreview.src = streamUrl;
      videoAudioPreview.load();
      
      videoDownloadBtn.href = downloadUrl;
      videoDownloadBtn.setAttribute('download', downloadName);
      
      videoProgressWrap.classList.add('hidden');
      videoResultWrap.classList.remove('hidden');
      return;
    }
    
    if (job.status === 'error') {
      stopVideoJobPolling();
      showError(job.message || 'Conversion failed.');
      cancelVideoProcess();
      return;
    }
    
    // Still converting, update conversion progress
    setVideoProgress(job.progress || 0, job.message || 'Extracting audio track...');
  } catch (err) {
    // Network glitch - let it retry silently
  }
}

if (videoConvertAnotherBtn) {
  videoConvertAnotherBtn.addEventListener('click', () => {
    cancelVideoProcess();
  });
}

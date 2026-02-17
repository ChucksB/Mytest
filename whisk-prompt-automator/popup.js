/* =========================================================
   popup.js — Whisk Prompt Automator
   Handles: file reading, JSON extraction, tab messaging,
            progress display, countdown timer.
   ========================================================= */

'use strict';

// ── State ─────────────────────────────────────────────────
let extractedPrompts = [];    // array of raw JSON strings
let whiskTabId       = null;
let isRunning        = false;
let countdownTimer   = null;

// ── Init ──────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  bindUI();
  restoreSettings();
  checkRunningStatus();

  // Listen for live updates pushed back from content script
  chrome.runtime.onMessage.addListener(onContentMessage);
});

// ── UI binding ────────────────────────────────────────────
function bindUI() {
  const uploadArea  = document.getElementById('uploadArea');
  const fileInput   = document.getElementById('fileInput');

  // Click anywhere on the upload area to open file picker
  uploadArea.addEventListener('click', () => fileInput.click());

  // Drag-and-drop
  uploadArea.addEventListener('dragover', (e) => {
    e.preventDefault();
    uploadArea.classList.add('dragover');
  });
  uploadArea.addEventListener('dragleave', () => uploadArea.classList.remove('dragover'));
  uploadArea.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadArea.classList.remove('dragover');
    const file = e.dataTransfer.files[0];
    if (file) readFile(file);
  });

  fileInput.addEventListener('change', (e) => {
    if (e.target.files[0]) readFile(e.target.files[0]);
  });

  document.getElementById('startBtn').addEventListener('click', handleStart);
  document.getElementById('stopBtn').addEventListener('click', handleStop);

  // Save delay preference whenever it changes
  document.getElementById('delayInput').addEventListener('change', saveSettings);
  document.getElementById('autoClickGenerate').addEventListener('change', saveSettings);
}

// ── Settings persistence ──────────────────────────────────
function saveSettings() {
  chrome.storage.local.set({
    delay: document.getElementById('delayInput').value,
    autoClick: document.getElementById('autoClickGenerate').checked
  });
}

function restoreSettings() {
  chrome.storage.local.get(['delay', 'autoClick', 'prompts', 'fileName'], (result) => {
    if (result.delay !== undefined) {
      document.getElementById('delayInput').value = result.delay;
    }
    if (result.autoClick !== undefined) {
      document.getElementById('autoClickGenerate').checked = result.autoClick;
    }
    // Restore previously loaded prompts so closing the popup doesn't lose them
    if (result.prompts && result.prompts.length > 0) {
      extractedPrompts = result.prompts;
      updateFileUI(result.fileName || 'Previously loaded file', result.prompts.length);
    }
  });
}

// ── File Reading ──────────────────────────────────────────
function readFile(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    const text = e.target.result;
    extractedPrompts = extractJsonBlocks(text);
    // Persist so reopening the popup doesn't lose the loaded file
    chrome.storage.local.set({ prompts: extractedPrompts, fileName: file.name });
    updateFileUI(file.name, extractedPrompts.length);
  };
  reader.onerror = () => showStatus('Could not read file.', 'error');
  reader.readAsText(file);
}

/**
 * Extract all top-level { } blocks from freeform text.
 * Uses brace-depth tracking only — no strict JSON.parse() validation,
 * so prompts with trailing commas, single quotes, or minor formatting
 * quirks are still captured.
 * Text between blocks (like "Image Prompt 3:") is ignored.
 */
function extractJsonBlocks(text) {
  const blocks = [];
  let depth      = 0;
  let start      = -1;
  let inString   = false;
  let escapeNext = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (escapeNext)              { escapeNext = false; continue; }
    if (ch === '\\' && inString) { escapeNext = true;  continue; }
    if (ch === '"')              { inString = !inString; continue; }
    if (inString)                { continue; }

    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        blocks.push(text.substring(start, i + 1));
        start = -1;
      }
    }
  }

  return blocks;
}

// ── UI Helpers ────────────────────────────────────────────
function updateFileUI(fileName, count) {
  const uploadArea = document.getElementById('uploadArea');
  const hint       = document.getElementById('uploadHint');
  const countEl   = document.getElementById('promptsCount');
  const startBtn   = document.getElementById('startBtn');

  hint.textContent = fileName;

  if (count > 0) {
    uploadArea.classList.add('has-file');
    countEl.textContent = `${count} prompt${count !== 1 ? 's' : ''} found`;
    countEl.className   = 'prompts-count found';
    startBtn.disabled   = false;
    showStatus(`Loaded ${count} prompt${count !== 1 ? 's' : ''} from "${fileName}".`, 'success');
  } else {
    uploadArea.classList.remove('has-file');
    countEl.textContent = 'No prompts found';
    countEl.className   = 'prompts-count none';
    startBtn.disabled   = true;
    showStatus(
      'No valid JSON blocks found. Make sure your file contains prompts in { } format.',
      'error'
    );
  }
}

function setRunningState(running) {
  isRunning = running;
  document.getElementById('startBtn').style.display = running ? 'none' : 'flex';
  document.getElementById('stopBtn').style.display  = running ? 'flex' : 'none';
  if (!running && countdownTimer) {
    clearInterval(countdownTimer);
    document.getElementById('countdown').style.display = 'none';
  }
}

function showProgress(current, total, message) {
  const section  = document.getElementById('progressSection');
  const fill     = document.getElementById('progressBarFill');
  const fraction = document.getElementById('progressFraction');
  const msg      = document.getElementById('progressMessage');

  section.style.display  = 'block';
  fill.style.width       = total > 0 ? `${(current / total) * 100}%` : '0%';
  fraction.textContent   = `${current} / ${total}`;
  msg.textContent        = message || 'Processing…';
}

function startCountdown(seconds) {
  const el = document.getElementById('countdown');
  let remaining = seconds;
  el.style.display = 'block';
  el.textContent   = `Next prompt in ${remaining}s…`;

  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = setInterval(() => {
    remaining--;
    if (remaining <= 0) {
      clearInterval(countdownTimer);
      el.style.display = 'none';
    } else {
      el.textContent = `Next prompt in ${remaining}s…`;
    }
  }, 1000);
}

function showStatus(message, type) {
  const el   = document.getElementById('statusMsg');
  el.textContent   = message;
  el.className     = `status-msg ${type}`;
  el.style.display = 'block';
}

// ── Tab Discovery ─────────────────────────────────────────
async function findWhiskTab() {
  const tabs = await chrome.tabs.query({ url: 'https://labs.google/*' });
  return tabs.length > 0 ? tabs[0].id : null;
}

// ── Start ─────────────────────────────────────────────────
async function handleStart() {
  if (extractedPrompts.length === 0) {
    showStatus('Upload a prompt file first.', 'error');
    return;
  }

  whiskTabId = await findWhiskTab();
  if (!whiskTabId) {
    showStatus(
      'Google Whisk tab not found. Open https://labs.google/fx/tools/whisk/ first.',
      'error'
    );
    return;
  }

  const delay     = Math.max(5, parseInt(document.getElementById('delayInput').value) || 30);
  const autoClick = document.getElementById('autoClickGenerate').checked;

  try {
    const response = await chrome.tabs.sendMessage(whiskTabId, {
      action:     'start',
      prompts:    extractedPrompts,
      delay:      delay,
      autoClick:  autoClick
    });

    if (response && response.success) {
      setRunningState(true);
      showProgress(0, extractedPrompts.length, 'Starting…');
      showStatus(`Automation started — ${extractedPrompts.length} prompts queued.`, 'info');
    } else {
      showStatus(response?.error || 'Failed to start automation.', 'error');
    }
  } catch (err) {
    showStatus(
      'Cannot connect to Whisk tab. Try refreshing the Whisk page, then try again.',
      'error'
    );
  }
}

// ── Stop ──────────────────────────────────────────────────
async function handleStop() {
  if (whiskTabId) {
    try {
      await chrome.tabs.sendMessage(whiskTabId, { action: 'stop' });
    } catch (_) {}
  }
  setRunningState(false);
  showStatus('Automation stopped by user.', 'warning');
}

// ── Messages from content script ──────────────────────────
function onContentMessage(message) {
  switch (message.type) {

    case 'progress':
      showProgress(message.current, message.total, `Pasting prompt ${message.current} of ${message.total}…`);
      if (message.current < message.total) {
        startCountdown(message.delay);
      }
      break;

    case 'complete':
      setRunningState(false);
      showProgress(message.total, message.total, 'All prompts completed!');
      showStatus(`Done! All ${message.total} prompts were sent to Whisk.`, 'success');
      break;

    case 'error':
      setRunningState(false);
      showStatus(`Error: ${message.message}`, 'error');
      break;

    case 'warning':
      showStatus(`Warning: ${message.message}`, 'warning');
      break;
  }
}

// ── Resume detection ──────────────────────────────────────
async function checkRunningStatus() {
  const tabId = await findWhiskTab();
  if (!tabId) return;

  try {
    const status = await chrome.tabs.sendMessage(tabId, { action: 'getStatus' });
    if (status && status.running) {
      whiskTabId = tabId;
      setRunningState(true);
      showProgress(
        status.currentIndex,
        status.total,
        `Resuming: prompt ${status.currentIndex} of ${status.total}`
      );
      showStatus('Automation is already running in the Whisk tab.', 'info');
    }
  } catch (_) {
    // content script not yet ready, nothing to resume
  }
}

/* =========================================================
   content.js — Whisk Prompt Automator
   Runs inside the Google Whisk tab.
   Finds the prompt textarea, sets its value in a way that
   React / Lit / Angular change-detection picks up, then
   optionally clicks the Generate button — all sequentially
   with a configurable delay between each prompt.
   ========================================================= */

'use strict';

// ── Automation state ──────────────────────────────────────
const state = {
  running:      false,
  prompts:      [],      // array of raw JSON strings
  currentIndex: 0,
  delay:        30,      // seconds
  autoClick:    true,
  timeoutId:    null
};

// ── Message listener ──────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg.action) {

    case 'start':
      if (state.running) {
        sendResponse({ success: false, error: 'Already running.' });
        return true;
      }
      state.prompts      = msg.prompts  || [];
      state.delay        = msg.delay    || 30;
      state.autoClick    = msg.autoClick !== false;
      state.currentIndex = 0;
      state.running      = true;

      // Small grace period so the popup can finish rendering
      setTimeout(() => processNext(), 300);
      sendResponse({ success: true });
      break;

    case 'stop':
      stopAutomation();
      sendResponse({ success: true });
      break;

    case 'getStatus':
      sendResponse({
        running:      state.running,
        currentIndex: state.currentIndex,
        total:        state.prompts.length
      });
      break;
  }
  return true; // keep channel open for async sendResponse
});

// ── Core loop ─────────────────────────────────────────────
function processNext() {
  if (!state.running) return;

  if (state.currentIndex >= state.prompts.length) {
    // All done
    state.running = false;
    sendToPopup({ type: 'complete', total: state.prompts.length });
    return;
  }

  const promptText = state.prompts[state.currentIndex];
  const current    = state.currentIndex + 1;
  const total      = state.prompts.length;

  sendToPopup({ type: 'progress', current, total, delay: state.delay });

  const ok = pastePrompt(promptText);

  if (!ok) {
    state.running = false;
    sendToPopup({
      type:    'error',
      message: `Could not find Whisk prompt input field while processing prompt ${current}. ` +
               'Make sure the Whisk page is fully loaded and the prompt area is visible.'
    });
    return;
  }

  // Advance index, then schedule next iteration after delay
  state.currentIndex++;
  state.timeoutId = setTimeout(() => processNext(), state.delay * 1000);
}

function stopAutomation() {
  state.running = false;
  if (state.timeoutId) {
    clearTimeout(state.timeoutId);
    state.timeoutId = null;
  }
}

// ── Prompt pasting ────────────────────────────────────────
function pastePrompt(text) {
  const input = findPromptInput();
  if (!input) return false;

  // Clear existing text, then set new value
  setElementValue(input, text);

  // Optionally click the generate button after a short settle time
  if (state.autoClick) {
    setTimeout(() => {
      const clicked = clickGenerateButton();
      if (!clicked) {
        sendToPopup({
          type:    'warning',
          message: `Prompt ${state.currentIndex} pasted but Generate button not found. ` +
                   'You may need to click it manually.'
        });
      }
    }, 600);
  }

  return true;
}

// ── Finding the prompt input ──────────────────────────────
/**
 * Priority list of CSS selectors tried in order.
 * Whisk may use a textarea, a contenteditable div, or a
 * custom web-component whose shadow root contains one.
 */
const PROMPT_SELECTORS = [
  // Specific selectors likely used by Whisk / Google Labs
  'textarea[aria-label*="prompt" i]',
  'textarea[placeholder*="prompt" i]',
  'textarea[data-testid*="prompt"]',
  '[aria-label*="prompt" i] textarea',
  '[aria-label*="prompt" i]',
  'textarea[aria-label*="caption" i]',
  'textarea[placeholder*="describe" i]',
  'textarea[placeholder*="Enter" i]',

  // Generic fallbacks
  'textarea',
  '[contenteditable="true"]',
];

function findPromptInput() {
  // 1. Try the regular (non-shadow) DOM
  for (const sel of PROMPT_SELECTORS) {
    const el = document.querySelector(sel);
    if (el && isUsable(el)) return el;
  }

  // 2. Walk through all shadow roots recursively
  return deepQueryShadow(document.documentElement, PROMPT_SELECTORS);
}

/**
 * Depth-first traversal of every shadow root in the page.
 * Returns the first matching, usable element.
 */
function deepQueryShadow(root, selectors) {
  for (const el of root.querySelectorAll('*')) {
    if (el.shadowRoot) {
      for (const sel of selectors) {
        const found = el.shadowRoot.querySelector(sel);
        if (found && isUsable(found)) return found;
      }
      // Recurse deeper
      const nested = deepQueryShadow(el.shadowRoot, selectors);
      if (nested) return nested;
    }
  }
  return null;
}

function isUsable(el) {
  if (!el) return false;
  if (el.disabled || el.readOnly) return false;
  const s = window.getComputedStyle(el);
  return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
}

// ── Setting element value (React / Lit compatible) ────────
function setElementValue(el, value) {
  el.focus();

  if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
    // Override React's synthetic event system by using the native setter
    const proto  = el.tagName === 'TEXTAREA'
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;

    if (setter) {
      setter.call(el, value);
    } else {
      el.value = value;
    }

    // Dispatch all events frameworks typically listen to
    ['input', 'change', 'keydown', 'keyup'].forEach((evtName) => {
      el.dispatchEvent(new Event(evtName, { bubbles: true, cancelable: true }));
    });

  } else if (el.isContentEditable || el.contentEditable === 'true') {
    // For contenteditable elements (Draft.js, Quill, etc.)
    el.focus();

    // Select all existing text and replace it
    document.execCommand('selectAll', false, null);
    document.execCommand('insertText', false, value);

    // Fallback if execCommand is blocked
    if (!el.textContent.includes(value.substring(0, 10))) {
      el.textContent = value;
      el.dispatchEvent(new Event('input',  { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  el.blur();
  el.focus();
}

// ── Finding and clicking the Generate button ──────────────
const GENERATE_SELECTORS = [
  'button[aria-label*="generate" i]',
  'button[aria-label*="create"   i]',
  'button[aria-label*="remix"    i]',
  'button[aria-label*="run"      i]',
  'button[aria-label*="submit"   i]',
  'button[type="submit"]',
  '[role="button"][aria-label*="generate" i]',
  '[role="button"][aria-label*="create"   i]',
  '[role="button"][aria-label*="submit"   i]',
];

const GENERATE_TEXT_KEYWORDS = ['generate', 'create', 'remix', 'run'];

function clickGenerateButton() {
  // 1. Attribute-based selectors (fastest)
  for (const sel of GENERATE_SELECTORS) {
    const btn = document.querySelector(sel)
              || deepQueryShadow(document.documentElement, [sel]);
    if (btn && !btn.disabled) {
      btn.click();
      return true;
    }
  }

  // 2. Text-content scan across all buttons
  const allButtons = [
    ...document.querySelectorAll('button, [role="button"]'),
    ...collectShadowButtons(document.documentElement)
  ];

  for (const btn of allButtons) {
    const txt = (btn.textContent || btn.innerText || '').toLowerCase().trim();
    if (GENERATE_TEXT_KEYWORDS.some((kw) => txt === kw || txt.includes(kw))) {
      if (!btn.disabled) {
        btn.click();
        return true;
      }
    }
  }

  // 3. Find the submit/arrow button near the prompt input.
  //    Whisk uses an icon-only → button with no text or aria-label, so
  //    text/attribute searches miss it. The button is always the last
  //    non-disabled button in the same container as the textarea.
  const input = findPromptInput();
  if (input) {
    const btn = findLastButtonNearInput(input);
    if (btn) {
      btn.click();
      return true;
    }
  }

  // 4. Last resort — press Enter in the input field
  if (input) {
    input.dispatchEvent(new KeyboardEvent('keydown', {
      key:       'Enter',
      code:      'Enter',
      keyCode:   13,
      bubbles:   true,
      cancelable: true
    }));
    return true;
  }

  return false;
}

/**
 * Walk up from the prompt input, looking for a container that holds
 * a small set of buttons (≤ 12). Return the last enabled one — in
 * Whisk's layout that is always the → (execute) button.
 * Works for both regular DOM and shadow-root containers.
 */
function findLastButtonNearInput(inputEl) {
  let container = inputEl.parentElement;
  // getRootNode() gives the ShadowRoot when input lives in one
  const root = inputEl.getRootNode();

  for (let depth = 0; depth < 8 && container && container !== root; depth++) {
    const btns = Array.from(
      container.querySelectorAll('button, [role="button"]')
    ).filter(b => !b.disabled && isUsable(b));

    // A container with 1–12 buttons is the toolbar row we want.
    // Skip huge containers (the whole page body) to avoid mis-clicks.
    if (btns.length >= 1 && btns.length <= 12) {
      return btns[btns.length - 1];
    }
    container = container.parentElement;
  }
  return null;
}

function collectShadowButtons(root) {
  const results = [];
  for (const el of root.querySelectorAll('*')) {
    if (el.shadowRoot) {
      results.push(...el.shadowRoot.querySelectorAll('button, [role="button"]'));
      results.push(...collectShadowButtons(el.shadowRoot));
    }
  }
  return results;
}

// ── Send message back to popup ────────────────────────────
function sendToPopup(data) {
  chrome.runtime.sendMessage(data).catch(() => {
    // Popup may be closed — safe to ignore
  });
}

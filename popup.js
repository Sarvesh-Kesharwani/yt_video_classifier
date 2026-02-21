// ── DOM References ──────────────────────────────────────────────────────────

// Filter tab
const input              = document.getElementById('keyword-input');
const addBtn             = document.getElementById('add-btn');
const listEl             = document.getElementById('keyword-list');
const listLabel          = document.getElementById('list-label');
const toggle             = document.getElementById('enabled-toggle');
const statusLabel        = document.getElementById('status-label');
const hiddenCountEl      = document.getElementById('hidden-count');
const fmBtns             = document.querySelectorAll('.fm-btn');
const channelModeSection = document.getElementById('channel-mode-section');
const channelCountEl     = document.getElementById('channel-count');
const channelListEl      = document.getElementById('channel-list');
const aiChannelToggle    = document.getElementById('ai-channel-toggle');
const modeRow            = document.querySelector('.mode-row');
const inputRow           = document.querySelector('.input-row');
const editRadios         = document.querySelectorAll('input[name="edit-list"]');

// Settings tab 
const savePathInput      = document.getElementById('save-path-input');
const saveConfigBtn      = document.getElementById('save-config-btn');
const loadConfigBtn      = document.getElementById('load-config-btn');
const logBtn             = document.getElementById('log-btn');
const aiProviderSelect   = document.getElementById('ai-provider');
const modelInput         = document.getElementById('model-input');
const apikeyRow          = document.getElementById('apikey-row');
const apiKeyInput        = document.getElementById('api-key-input');
const apiBaseUrlInput    = document.getElementById('api-base-url-input');

// Hidden file picker
const configFile         = document.getElementById('config-file');

// Saved videos
const exportSavedBtn     = document.getElementById('export-saved-btn');
const clearSavedBtn      = document.getElementById('clear-saved-btn');
const savedCountEl       = document.getElementById('saved-count');


// ── State ───────────────────────────────────────────────────────────────────

let blockCategories = [];
let allowCategories = [];
let enabled       = true;
let filteringMode = 'keyword'; // 'keyword' | 'category'
let editList      = 'block';
let ollamaModel   = 'qwen2.5-coder:7b';
let aiProvider    = 'ollama';
let apiKey        = '';
let apiBaseUrl    = 'https://api.openai.com/v1';
let savePath        = 'yt-filter'; // relative to Downloads
let aiChannelFilter = false;


function activeList() {
  return editList === 'block' ? blockCategories : allowCategories;
}


// ── Tab switching ────────────────────────────────────────────────────────────

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b === btn));
    document.getElementById('tab-filter').style.display   = btn.dataset.tab === 'filter'   ? 'block' : 'none';
    document.getElementById('tab-settings').style.display = btn.dataset.tab === 'settings' ? 'block' : 'none';
  });
});


// ── Init ─────────────────────────────────────────────────────────────────────

chrome.storage.sync.get(
  ['blockCategories', 'allowCategories', 'enabled', 'filteringMode', 'editList',
   'ollamaModel', 'aiProvider', 'apiKey', 'apiBaseUrl', 'savePath', 'aiChannelFilter'],
  (data) => {
    blockCategories = data.blockCategories || [];
    allowCategories = data.allowCategories || [];
    enabled         = data.enabled !== undefined ? data.enabled : true;
    filteringMode   = data.filteringMode || 'keyword';
    editList        = data.editList      || 'block';
    ollamaModel     = data.ollamaModel   || 'qwen2.5-coder:7b';
    aiProvider      = data.aiProvider    || 'ollama';
    apiKey          = data.apiKey        || '';
    apiBaseUrl      = data.apiBaseUrl    || 'https://api.openai.com/v1';
    savePath        = data.savePath      || 'yt-filter';
    aiChannelFilter = !!data.aiChannelFilter;

    // Filter tab
    toggle.checked = enabled;
    statusLabel.textContent = enabled ? 'Enabled' : 'Disabled';
    editRadios.forEach(r => { r.checked = r.value === editList; });
    aiChannelToggle.checked = aiChannelFilter;

    // Settings tab
    aiProviderSelect.value = aiProvider;
    modelInput.value       = ollamaModel;
    apiKeyInput.value      = apiKey;
    apiBaseUrlInput.value  = apiBaseUrl;
    savePathInput.value    = savePath;

    updateModeUI();
    renderCategories();
  }
);


// Load saved-video count
chrome.storage.local.get(['savedVideos'], (data) => {
  const n = (data.savedVideos || []).length;
  savedCountEl.textContent = `${n} video${n !== 1 ? 's' : ''} saved`;
});

// Fetch hidden count from content script
chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  if (tabs[0]?.id) {
    chrome.tabs.sendMessage(tabs[0].id, { type: 'GET_HIDDEN_COUNT' })
      .then(r => { if (r?.count !== undefined) hiddenCountEl.textContent = r.count; })
      .catch(() => { hiddenCountEl.textContent = '0'; });
  }
});


// ── Filtering mode 3-way selector ────────────────────────────────────────────

fmBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    filteringMode = btn.dataset.mode;
    updateModeUI();
    save();
  });
});

function updateModeUI() {
  const isChannel = filteringMode === 'channel';

  // Update active button
  fmBtns.forEach(btn => btn.classList.toggle('active', btn.dataset.mode === filteringMode));

  // Show/hide sections depending on mode
  modeRow.style.display            = isChannel ? 'none' : '';
  inputRow.style.display           = isChannel ? 'none' : '';
  listLabel.style.display          = isChannel ? 'none' : '';
  listEl.style.display             = isChannel ? 'none' : '';
  channelModeSection.style.display = isChannel ? 'block' : 'none';

  if (!isChannel) {
    input.placeholder = filteringMode === 'category'
      ? 'Enter a category (e.g. gaming)...'
      : 'Enter a keyword...';
  }

  if (isChannel) renderChannelList();
  updateProviderUI();
  renderCategories();
}

function updateProviderUI() {
  apikeyRow.style.display = aiProvider !== 'ollama' ? 'flex' : 'none';
}

aiChannelToggle.addEventListener('change', () => {
  aiChannelFilter = aiChannelToggle.checked;
  save();
});


// ── Edit-list radio (block / allow) ──────────────────────────────────────────

editRadios.forEach(r => {
  r.addEventListener('change', () => {
    if (r.checked) {
      editList = r.value;
      renderCategories();
      chrome.storage.sync.set({ editList });
    }
  });
});


// ── Add / Remove entries ─────────────────────────────────────────────────────

function addCategory() {
  const word = input.value.trim().toLowerCase();
  const list = activeList();
  if (!word || list.includes(word)) { input.value = ''; return; }
  list.push(word);
  save();
  input.value = '';
  input.focus();
}

addBtn.addEventListener('click', addCategory);
input.addEventListener('keydown', e => { if (e.key === 'Enter') addCategory(); });

function removeCategory(word) {
  if (editList === 'block') {
    blockCategories = blockCategories.filter(k => k !== word);
  } else {
    allowCategories = allowCategories.filter(k => k !== word);
  }
  save();
}


// ── Enable toggle ─────────────────────────────────────────────────────────────

toggle.addEventListener('change', () => {
  enabled = toggle.checked;
  statusLabel.textContent = enabled ? 'Enabled' : 'Disabled';
  save();
});


// ── Settings: AI provider ────────────────────────────────────────────────────

aiProviderSelect.addEventListener('change', () => {
  aiProvider = aiProviderSelect.value;
  updateProviderUI();
  save();
});


// ── Settings: Model ───────────────────────────────────────────────────────────

modelInput.addEventListener('change', () => {
  ollamaModel = modelInput.value.trim() || 'qwen2.5-coder:7b';
  save();
});


// ── Settings: API key & Base URL ─────────────────────────────────────────────

apiKeyInput.addEventListener('change', () => {
  apiKey = apiKeyInput.value.trim();
  save();
});

apiBaseUrlInput.addEventListener('change', () => {
  apiBaseUrl = apiBaseUrlInput.value.trim() || 'https://api.openai.com/v1';
  save();
});


// ── Settings: Save path ───────────────────────────────────────────────────────

savePathInput.addEventListener('change', () => {
  savePath = savePathInput.value.trim() || 'yt-filter';
  savePathInput.value = savePath;
  chrome.storage.sync.set({ savePath });
});


// ── Saved videos: Export & Clear ─────────────────────────────────────────────

exportSavedBtn.addEventListener('click', () => {
  chrome.storage.local.get(['savedVideos'], (data) => {
    writeFile(data.savedVideos || [], `${savePath}/saved-videos.json`);
  });
});

clearSavedBtn.addEventListener('click', () => {
  chrome.storage.local.set({ savedVideos: [] }, () => {
    savedCountEl.textContent = '0 videos saved';
  });
});


// ── Save config to file ───────────────────────────────────────────────────────
// Writes everything to <Downloads>/<savePath>/config.json

saveConfigBtn.addEventListener('click', () => {
  const config = buildConfig();
  const path   = `${savePath}/config.json`;
  writeFile(config, path);
});


// ── Load config from file ─────────────────────────────────────────────────────

loadConfigBtn.addEventListener('click', () => configFile.click());

configFile.addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = ev => {
    try {
      applyConfig(JSON.parse(ev.target.result));
    } catch {
      // Invalid JSON — ignore silently
    }
  };
  reader.readAsText(file);
  configFile.value = ''; // reset so same file can be re-loaded
});

function applyConfig(cfg) {
  if (Array.isArray(cfg.blockCategories)) blockCategories = cfg.blockCategories;
  if (Array.isArray(cfg.allowCategories)) allowCategories = cfg.allowCategories;
  if (['keyword', 'category', 'channel'].includes(cfg.filteringMode)) filteringMode = cfg.filteringMode;
  if (cfg.aiProvider === 'ollama' || cfg.aiProvider === 'openai') {
    aiProvider = cfg.aiProvider;
    aiProviderSelect.value = aiProvider;
  }
  if (typeof cfg.ollamaModel === 'string' && cfg.ollamaModel) {
    ollamaModel = cfg.ollamaModel;
    modelInput.value = ollamaModel;
  }
  if (typeof cfg.apiKey === 'string') {
    apiKey = cfg.apiKey;
    apiKeyInput.value = apiKey;
  }
  if (typeof cfg.apiBaseUrl === 'string' && cfg.apiBaseUrl) {
    apiBaseUrl = cfg.apiBaseUrl;
    apiBaseUrlInput.value = apiBaseUrl;
  }
  if (typeof cfg.savePath === 'string' && cfg.savePath) {
    savePath = cfg.savePath;
    savePathInput.value = savePath;
  }
  if (cfg.aiChannelFilter !== undefined) {
    aiChannelFilter = !!cfg.aiChannelFilter;
    aiChannelToggle.checked = aiChannelFilter;
  }
  updateModeUI();
  save();
}


// ── Log download ──────────────────────────────────────────────────────────────

logBtn.addEventListener('click', () => {
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    if (!tabs[0]?.id) return;
    chrome.tabs.sendMessage(tabs[0].id, { type: 'GET_LOG' })
      .then(r => writeFile(r.log, `${savePath}/ollama-log.json`))
      .catch(() => {});
  });
});


// ── Persist to chrome.storage & notify content script ────────────────────────

function save() {
  chrome.storage.sync.set(
    { blockCategories, allowCategories, enabled, filteringMode, editList,
      ollamaModel, aiProvider, apiKey, apiBaseUrl, savePath, aiChannelFilter },
    () => {
      renderCategories();
      chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
        if (tabs[0]?.id) {
          chrome.tabs.sendMessage(tabs[0].id, { type: 'UPDATE_FILTER' }).catch(() => {});
        }
      });
    }
  );
}


// ── Render pills for the active edit list ─────────────────────────────────────

function renderCategories() {
  if (filteringMode === 'channel') return; // channel mode uses renderChannelList instead
  const list = activeList();
  const noun  = filteringMode === 'keyword' ? 'keyword' : 'category';
  listLabel.textContent = editList === 'block'
    ? `Block ${noun}s — hide matches (${list.length})`
    : `Allow ${noun}s — show only matches (${list.length})`;

  listEl.innerHTML = '';
  list.forEach(word => {
    const pill = document.createElement('div');
    pill.className = 'keyword-pill';
    pill.innerHTML = `
      <span>${escapeHTML(word)}</span>
      <button class="remove-btn" title="Remove">&times;</button>
    `;
    pill.querySelector('.remove-btn').addEventListener('click', () => removeCategory(word));
    listEl.appendChild(pill);
  });
}


// ── Channel mode: render blocked channels ─────────────────────────────────────

function renderChannelList() {
  chrome.storage.local.get(['savedVideos', 'aiBlockedChannels'], (data) => {
    const saved     = data.savedVideos      || [];
    const aiBlocked = data.aiBlockedChannels || [];

    // Manual channels from saved videos
    const manualMap = new Map();
    for (const v of saved) {
      if (!v.video_channel_info) continue;
      const { channel_name, handle } = v.video_channel_info;
      const key = handle || channel_name;
      if (key && !manualMap.has(key)) manualMap.set(key, { channel_name, handle });
    }

    // AI-recommended channels (exclude any already in manual)
    const aiMap = new Map();
    for (const ch of aiBlocked) {
      const key = ch.handle || ch.channel_name;
      if (key && !manualMap.has(key) && !aiMap.has(key)) {
        aiMap.set(key, { channel_name: ch.channel_name, handle: ch.handle });
      }
    }

    const total = manualMap.size + aiMap.size;
    channelCountEl.textContent = `${total} channel${total !== 1 ? 's' : ''} blocked` +
      (aiMap.size > 0 ? ` (${aiMap.size} by AI)` : '');
    channelListEl.innerHTML = '';

    // Render manual channels
    for (const [key, ch] of manualMap) {
      channelListEl.appendChild(buildChannelPill(ch, key, 'manual'));
    }

    // Render AI-recommended channels
    for (const [key, ch] of aiMap) {
      channelListEl.appendChild(buildChannelPill(ch, key, 'ai'));
    }
  });
}

function buildChannelPill(ch, key, source) {
  const pill = document.createElement('div');
  pill.className = 'keyword-pill';
  const nameHtml   = escapeHTML(ch.channel_name || key);
  const handleHtml = ch.handle
    ? `<br><small style="color:#888">${escapeHTML(ch.handle)}</small>`
    : '';
  const aiTag = source === 'ai'
    ? ' <small style="color:#f80;font-weight:bold">[AI]</small>'
    : '';
  pill.innerHTML = `
    <span>${nameHtml}${aiTag}${handleHtml}</span>
    <button class="remove-btn" title="Unblock channel">&times;</button>
  `;
  pill.querySelector('.remove-btn').addEventListener('click', () => {
    if (source === 'ai') removeAiBlockedChannel(key);
    else                 removeChannelFromSaved(key);
  });
  return pill;
}

function removeChannelFromSaved(key) {
  chrome.storage.local.get(['savedVideos'], (data) => {
    const filtered = (data.savedVideos || []).filter(v => {
      if (!v.video_channel_info) return true;
      const ch = v.video_channel_info;
      return (ch.handle || ch.channel_name) !== key;
    });
    chrome.storage.local.set({ savedVideos: filtered }, () => {
      renderChannelList();
      notifyContentScript();
    });
  });
}

function removeAiBlockedChannel(key) {
  chrome.storage.local.get(['aiBlockedChannels'], (data) => {
    const filtered = (data.aiBlockedChannels || []).filter(ch =>
      (ch.handle || ch.channel_name) !== key
    );
    chrome.storage.local.set({ aiBlockedChannels: filtered }, () => {
      renderChannelList();
      notifyContentScript();
    });
  });
}

function notifyContentScript() {
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    if (tabs[0]?.id) chrome.tabs.sendMessage(tabs[0].id, { type: 'UPDATE_FILTER' }).catch(() => {});
  });
}


// ── Utilities ─────────────────────────────────────────────────────────────────

function buildConfig() {
  return {
    blockCategories,
    allowCategories,
    filteringMode,
    aiProvider,
    ollamaModel,
    apiKey,
    apiBaseUrl,
    savePath,
    aiChannelFilter,
    savedAt: new Date().toISOString()
  };
}

// Save JSON to <Downloads>/<filename> via chrome.downloads
function writeFile(data, filename) {
  const json = JSON.stringify(data, null, 2);
  const url  = 'data:application/json;charset=utf-8,' + encodeURIComponent(json);
  chrome.downloads.download({ url, filename, saveAs: false }, (_id) => {
    if (chrome.runtime.lastError) {
      console.error('[YT Filter] Download error:', chrome.runtime.lastError.message);
    }
  });
}

function escapeHTML(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

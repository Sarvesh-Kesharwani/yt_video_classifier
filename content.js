// YouTube Video Filter – Content Script
(() => {

let blockCategories = [];
let allowCategories = [];
let enabled       = true;
let hiddenCount   = 0;
let ollamaModel   = 'qwen2.5-coder:7b';
let filteringMode = 'keyword'; // 'keyword' | 'category'
let aiProvider    = 'ollama';  // 'ollama' | 'openai'
let apiKey        = '';
let apiBaseUrl    = 'https://api.openai.com/v1';
let aiChannelFilter = false;

// Ollama/API result caches — only used in category mode
const blockCache = new Map(); // title -> boolean
const allowCache = new Map(); // title -> boolean

// Channel-similarity cache — used in channel mode with AI toggle
const channelSimilarityCache = new Map(); // channelKey -> boolean

// In-memory log of every AI API call
const apiLog = [];

// ── Saved-video list (user-curated for category discovery) ───────────────────

function getVideoUrl(videoEl) {
  const a = videoEl.querySelector('a#thumbnail') ||
            videoEl.querySelector('a[href*="/watch"]') ||
            videoEl.querySelector('a[href*="/shorts/"]');
  return a ? a.href : '';
}

// ── Channel info helpers ──────────────────────────────────────────────────────

function getChannelDomInfo(videoEl) {
  // Fast path: named selectors that cover most renderer types
  let channelLink =
    videoEl.querySelector('#channel-name a') ||
    videoEl.querySelector('ytd-channel-name a') ||
    videoEl.querySelector('ytd-video-meta-block a[href*="/@"]');

  // Broad fallback: first anchor whose href looks like a channel URL
  if (!channelLink) {
    channelLink = Array.from(videoEl.querySelectorAll('a[href]')).find(a => {
      const h = a.href || '';
      return (h.includes('/@') || h.includes('/channel/')) &&
             !h.includes('/watch') && !h.includes('/shorts/');
    });
  }

  if (!channelLink) {
    console.warn('[YT Filter] No channel link found in video element', videoEl);
    return null;
  }

  const channel_name = channelLink.textContent.trim();
  const href = channelLink.href || '';
  const handleMatch = href.match(/\/@([^/?&#]+)/);
  const handle = handleMatch ? `@${handleMatch[1]}` : '';
  const channelUrl = href.split('?')[0].replace(/\/$/, '');

  return { channel_name, handle, channelUrl };
}

async function fetchChannelDetails(channelUrl) {
  const currentYear = new Date().getFullYear();
  const result = { total_videos: null, years_active_from: null, years_active_to: currentYear, approx_years_active: null, description: '' };

  try {
    // Fetch the main channel page — YouTube redirects /about back here anyway
    const res = await fetch(channelUrl, {
      credentials: 'omit',
      headers: { 'Accept': 'text/html,application/xhtml+xml' }
    });
    if (!res.ok) {
      console.warn('[YT Filter] Channel page fetch status:', res.status, channelUrl);
      return result;
    }

    const html = await res.text();
    console.log('[YT Filter] Channel HTML fetched, length:', html.length, '| has ytInitialData:', html.includes('ytInitialData'));

    // Video count — try multiple key names YouTube has used over time
    for (const pat of [
      /"videosCountText":\{"content":"([^"]+)"/,
      /"videoCountText":\{"content":"([^"]+)"/,
      /"videosCountText":\{"runs":\[\{"text":"([^"]+)"/,
    ]) {
      const m = html.match(pat);
      if (m) {
        const n = parseInt(m[1].replace(/[^0-9]/g, ''), 10);
        if (!isNaN(n)) { result.total_videos = n; break; }
      }
    }

    // Join year
    for (const pat of [
      /"joinedDateText":\{"content":"([^"]+)"/,
      /"joinedDateText":\{"runs":\[\{"text":"([^"]+)"/,
      /"content":"(Joined [^"]{3,50})"/,
    ]) {
      const m = html.match(pat);
      if (m) {
        const yearMatch = m[1].match(/\b(20\d{2}|19\d{2})\b/);
        if (yearMatch) {
          result.years_active_from = parseInt(yearMatch[1], 10);
          result.approx_years_active = result.years_active_to - result.years_active_from;
          break;
        }
      }
    }

    // Description
    for (const pat of [
      /"description":\{"content":"((?:[^"\\]|\\.)*)"/,
      /"descriptionPreviewText":\{"content":"((?:[^"\\]|\\.)*)"/,
      /"channelDescriptionExpandableString":\{"content":"((?:[^"\\]|\\.)*)"/,
    ]) {
      const m = html.match(pat);
      if (m && m[1].length > 0) {
        result.description = m[1].replace(/\\n/g, ' ').replace(/\\"/g, '"').trim();
        break;
      }
    }

    console.log('[YT Filter] Channel details parsed:', {
      total_videos: result.total_videos,
      years_active_from: result.years_active_from,
      description_chars: result.description.length,
    });
  } catch (e) {
    console.error('[YT Filter] fetchChannelDetails error:', e.message);
  }

  return result;
}

async function classifyChannelContentType(channel_name, description) {
  if (!channel_name && !description) return [];

  const prompt =
    `YouTube channel name: "${channel_name}"\n` +
    (description ? `Channel description: "${description.slice(0, 500)}"\n` : '') +
    `List 4-6 short content-type descriptors that characterize this channel's content.\n` +
    `Reply ONLY with a JSON array of strings, e.g. ["type 1", "type 2"]. No explanation.`;

  try {
    let raw;
    if (aiProvider === 'ollama') {
      const res = await fetch('http://localhost:11434/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: ollamaModel, prompt, stream: false })
      });
      const data = await res.json();
      raw = data.response.trim();
    } else {
      const res = await fetch(`${apiBaseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: ollamaModel,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 150,
          temperature: 0.3
        })
      });
      const data = await res.json();
      raw = data.choices[0].message.content.trim();
    }
    const arrayMatch = raw.match(/\[[\s\S]*\]/);
    if (arrayMatch) return JSON.parse(arrayMatch[0]);
  } catch (e) {
    console.error('[YT Filter] classifyChannelContentType error:', e.message);
  }
  return [];
}

async function buildChannelInfo(videoEl) {
  const domInfo = getChannelDomInfo(videoEl);
  if (!domInfo) return null;

  const { channel_name, handle, channelUrl } = domInfo;
  const details = channelUrl ? await fetchChannelDetails(channelUrl) : {};
  const content_type = await classifyChannelContentType(channel_name, details.description || '');

  const info = { channel_name, handle };
  if (details.total_videos      != null) info.total_videos      = details.total_videos;
  if (details.years_active_from != null) info.years_active_from = details.years_active_from;
  if (details.years_active_to)           info.years_active_to   = details.years_active_to;
  if (details.approx_years_active != null) info.approx_years_active = details.approx_years_active;
  info.content_type = content_type;
  return info;
}

async function addToSavedVideos(title, url, videoEl) {
  if (!title && !url) return;

  const video_channel_info = videoEl ? await buildChannelInfo(videoEl) : null;

  return new Promise((resolve) => {
    chrome.storage.local.get(['savedVideos'], (data) => {
      const list = data.savedVideos || [];
      if (!list.some(v => v.url === url && v.title === title)) {
        const entry = { title, url, savedAt: new Date().toISOString() };
        if (video_channel_info) entry.video_channel_info = video_channel_info;
        list.push(entry);
        chrome.storage.local.set({ savedVideos: list }, resolve);
      } else {
        resolve();
      }
    });
  });
}

function injectAddButtons() {
  document.querySelectorAll(VIDEO_SELECTORS).forEach(video => {
    if (video.dataset.ytFilterBtn) return;
    video.dataset.ytFilterBtn = '1';

    // Try candidates in order; use the first one found
    const container = video.querySelector('a#thumbnail')
                   || video.querySelector('ytd-thumbnail')
                   || video;

    // Force a positioning context and prevent clipping so our button is always visible
    container.style.setProperty('position', 'relative', 'important');
    container.style.setProperty('overflow',  'visible',  'important');

    const btn = document.createElement('button');
    btn.title = 'Add to block list';
    btn.textContent = '+';

    // All styles inline with !important — immune to any page CSS overrides
    btn.setAttribute('style', [
      'position: absolute !important',
      'bottom: 8px !important',
      'right: 8px !important',
      'width: 32px !important',
      'height: 32px !important',
      'border-radius: 50% !important',
      'background: rgba(220,0,0,0.95) !important',
      'color: white !important',
      'border: 2px solid rgba(255,255,255,0.85) !important',
      'font-size: 22px !important',
      'font-weight: bold !important',
      'cursor: pointer !important',
      'z-index: 2147483647 !important',
      'display: flex !important',
      'align-items: center !important',
      'justify-content: center !important',
      'padding: 0 !important',
      'line-height: 1 !important',
      'box-shadow: 0 2px 8px rgba(0,0,0,0.55) !important',
    ].join('; '));

    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (btn.dataset.busy) return;
      btn.dataset.busy = '1';
      btn.textContent = '…';
      btn.style.setProperty('background', 'rgba(180,120,0,0.95)', 'important');
      await addToSavedVideos(getTitleText(video), getVideoUrl(video), video);
      delete btn.dataset.busy;
      btn.textContent = '✓';
      btn.style.setProperty('background', 'rgba(0,180,0,0.95)', 'important');
      setTimeout(() => {
        btn.textContent = '+';
        btn.style.setProperty('background', 'rgba(220,0,0,0.95)', 'important');
      }, 1500);
    });

    container.appendChild(btn);
  });
}

const VIDEO_SELECTORS = [
  'ytd-rich-item-renderer',
  'ytd-video-renderer',
  'ytd-compact-video-renderer',
  'ytd-grid-video-renderer',
  'ytd-playlist-video-renderer',
  'ytd-reel-item-renderer',
  'ytd-rich-grid-slim-media'
].join(', ');

const TITLE_SELECTORS = [
  '#video-title',
  '#video-title-link',
  'yt-formatted-string#video-title',
  'a#video-title',
  'h3 a'
];

function getTitleText(videoEl) {
  for (const sel of TITLE_SELECTORS) {
    const titleEl = videoEl.querySelector(sel);
    if (titleEl) {
      const text = (titleEl.textContent || titleEl.getAttribute('title') || '').trim();
      if (text) return text;
    }
  }
  return '';
}

// — Keyword mode: fast substring match, no API calls —
function matchesKeywords(title, entries) {
  const lower = title.toLowerCase();
  return entries.some(entry => lower.includes(entry.toLowerCase()));
}

// — Category mode: ask the configured AI provider —
async function classifyTitle(title, categories, cacheMap, listLabel) {
  if (cacheMap.has(title)) {
    console.log(`[YT Filter] CACHE HIT [${listLabel}] "${title}" → ${cacheMap.get(title) ? 'matched' : 'no match'}`);
    return cacheMap.get(title);
  }

  const prompt =
    `Categories: ${categories.join(', ')}.\n` +
    `Video title: "${title}"\n` +
    `Does this video title belong to any of the listed categories? Reply only "yes" or "no".`;

  const logEntry = {
    timestamp: new Date().toISOString(),
    list: listLabel,
    provider: aiProvider,
    model: ollamaModel,
    title,
    categories: [...categories],
    prompt,
    rawResponse: null,
    matched: null,
    cached: false,
    error: null
  };

  console.log(`[YT Filter] REQUEST  [${listLabel}]  provider=${aiProvider}  model=${ollamaModel}`);
  console.log(`            title: "${title}"`);
  console.log(`            categories: ${categories.join(', ')}`);

  try {
    let raw;

    if (aiProvider === 'ollama') {
      const res = await fetch('http://localhost:11434/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: ollamaModel, prompt, stream: false })
      });
      const data = await res.json();
      raw = data.response.trim();

    } else {
      // OpenAI-compatible (OpenAI, Groq, LM Studio, etc.)
      const res = await fetch(`${apiBaseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: ollamaModel,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 5,
          temperature: 0
        })
      });
      const data = await res.json();
      raw = data.choices[0].message.content.trim();
    }

    const matched = raw.toLowerCase().startsWith('yes');
    logEntry.rawResponse = raw;
    logEntry.matched     = matched;
    console.log(`[YT Filter] RESPONSE [${listLabel}] "${raw}"  →  ${matched ? 'MATCHED ✓' : 'no match'}`);

    cacheMap.set(title, matched);
    apiLog.push(logEntry);
    return matched;

  } catch (err) {
    logEntry.error = err.message;
    apiLog.push(logEntry);
    console.error(`[YT Filter] ERROR [${listLabel}] classifying "${title}":`, err.message);
    return false; // fail open
  }
}

async function batchCheckSimilarity(blockedProfile, channels) {
  const results = new Map();
  if (channels.length === 0) return results;

  const themesBlock = blockedProfile.map(t => `- ${t}`).join('\n');
  const channelList = channels.map((ch, i) =>
    `${i + 1}. "${ch.channel_name}" (${ch.handle || 'no handle'})`
  ).join('\n');

  const prompt =
    `You are a content filter. The user has blocked channels with these content themes:\n` +
    themesBlock + '\n\n' +
    `Here are new channels. For each, reply "yes" if the channel likely produces content similar to the blocked themes, "no" otherwise.\n\n` +
    channelList + '\n\n' +
    `Reply ONLY with a JSON object mapping numbers to "yes" or "no", e.g. {"1":"yes","2":"no"}.`;

  console.log('[YT Filter] Batch similarity check for', channels.length, 'channels');

  try {
    let raw;
    if (aiProvider === 'ollama') {
      const res = await fetch('http://localhost:11434/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: ollamaModel, prompt, stream: false })
      });
      const data = await res.json();
      raw = data.response.trim();
    } else {
      const res = await fetch(`${apiBaseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: ollamaModel,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 300,
          temperature: 0
        })
      });
      const data = await res.json();
      raw = data.choices[0].message.content.trim();
    }

    console.log('[YT Filter] Batch similarity response:', raw);

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      channels.forEach((ch, i) => {
        const key = (ch.handle || ch.channel_name || '').toLowerCase();
        const answer = parsed[String(i + 1)];
        results.set(key, answer?.toLowerCase() === 'yes');
      });
    }
  } catch (e) {
    console.error('[YT Filter] batchCheckSimilarity error:', e.message);
    // Fail open — don't block on AI failure
    channels.forEach(ch => {
      const key = (ch.handle || ch.channel_name || '').toLowerCase();
      results.set(key, false);
    });
  }

  return results;
}

async function filterByChannel(videos) {
  const data = await new Promise(resolve =>
    chrome.storage.local.get(['savedVideos', 'aiBlockedChannels'], resolve)
  );
  const savedVideos      = data.savedVideos      || [];
  const aiBlockedChannels = data.aiBlockedChannels || [];

  // Build exact-match sets from manually saved videos
  const blockedHandles = new Set();
  const blockedNames   = new Set();
  const contentProfile = new Set();
  for (const v of savedVideos) {
    if (!v.video_channel_info) continue;
    const { handle, channel_name, content_type } = v.video_channel_info;
    if (handle)       blockedHandles.add(handle.toLowerCase());
    if (channel_name) blockedNames.add(channel_name.toLowerCase());
    if (Array.isArray(content_type)) content_type.forEach(t => contentProfile.add(t));
  }

  // Also treat persisted AI-recommended channels as blocked
  for (const ch of aiBlockedChannels) {
    if (ch.handle)       blockedHandles.add(ch.handle.toLowerCase());
    if (ch.channel_name) blockedNames.add(ch.channel_name.toLowerCase());
    // Warm the in-memory cache from persisted data
    const key = (ch.handle || ch.channel_name || '').toLowerCase();
    if (key && !channelSimilarityCache.has(key)) channelSimilarityCache.set(key, true);
  }

  if (blockedHandles.size === 0 && blockedNames.size === 0) {
    videos.forEach(v => { v.style.display = ''; });
    return 0;
  }

  // Phase 1: exact matches + cached similarity results
  let count = 0;
  const uncheckedChannels = new Map(); // channelKey -> { channel_name, handle, videoEls }

  for (const videoEl of videos) {
    const domInfo = getChannelDomInfo(videoEl);
    if (!domInfo) { videoEl.style.display = ''; continue; }

    const h = (domInfo.handle       || '').toLowerCase();
    const n = (domInfo.channel_name || '').toLowerCase();
    const cacheKey = h || n;

    // Exact match (manual + persisted AI) — always block
    if ((h && blockedHandles.has(h)) || (n && blockedNames.has(n))) {
      videoEl.style.display = 'none';
      count++;
      continue;
    }

    // Check similarity cache
    if (channelSimilarityCache.has(cacheKey)) {
      const similar = channelSimilarityCache.get(cacheKey);
      videoEl.style.display = similar ? 'none' : '';
      if (similar) count++;
      continue;
    }

    // Collect for AI batch check
    if (aiChannelFilter && contentProfile.size > 0 && cacheKey) {
      if (!uncheckedChannels.has(cacheKey)) {
        uncheckedChannels.set(cacheKey, { ...domInfo, videoEls: [] });
      }
      uncheckedChannels.get(cacheKey).videoEls.push(videoEl);
    } else {
      videoEl.style.display = '';
    }
  }

  // Phase 2: batch AI similarity check for unknown channels
  if (uncheckedChannels.size > 0) {
    const channelsToCheck = Array.from(uncheckedChannels.values());
    const results = await batchCheckSimilarity(Array.from(contentProfile), channelsToCheck);

    const newAiBlocked = [];
    for (const [key, similar] of results) {
      channelSimilarityCache.set(key, similar);
      const entry = uncheckedChannels.get(key);
      if (entry) {
        for (const el of entry.videoEls) {
          el.style.display = similar ? 'none' : '';
          if (similar) count++;
        }
        if (similar) {
          newAiBlocked.push({
            channel_name: entry.channel_name,
            handle: entry.handle,
            blockedAt: new Date().toISOString()
          });
        }
      }
    }

    // Persist newly discovered AI-blocked channels
    if (newAiBlocked.length > 0) {
      chrome.storage.local.get(['aiBlockedChannels'], (d) => {
        const existing = d.aiBlockedChannels || [];
        const existingKeys = new Set(existing.map(c => (c.handle || c.channel_name || '').toLowerCase()));
        const toAdd = newAiBlocked.filter(c => {
          const k = (c.handle || c.channel_name || '').toLowerCase();
          return !existingKeys.has(k);
        });
        if (toAdd.length > 0) {
          chrome.storage.local.set({ aiBlockedChannels: [...existing, ...toAdd] });
          console.log('[YT Filter] Persisted', toAdd.length, 'AI-recommended channel blocks');
        }
      });
    }
  }

  return count;
}

async function filterVideos() {
  const videos = Array.from(document.querySelectorAll(VIDEO_SELECTORS));

  if (!enabled) {
    videos.forEach(v => { v.style.display = ''; });
    hiddenCount = 0;
    injectAddButtons();
    return;
  }

  if (filteringMode === 'channel') {
    hiddenCount = await filterByChannel(videos);
    injectAddButtons();
    return;
  }

  if (blockCategories.length === 0 && allowCategories.length === 0) {
    videos.forEach(v => { v.style.display = ''; });
    hiddenCount = 0;
    injectAddButtons();
    return;
  }

  let count = 0;
  await Promise.all(videos.map(async (video) => {
    const title = getTitleText(video);
    if (!title) return;

    let blockMatched, allowMatched;

    if (filteringMode === 'keyword') {
      blockMatched = blockCategories.length > 0 ? matchesKeywords(title, blockCategories) : false;
      allowMatched = allowCategories.length > 0 ? matchesKeywords(title, allowCategories) : true;
    } else {
      blockMatched = blockCategories.length > 0
        ? await classifyTitle(title, blockCategories, blockCache, 'block')
        : false;
      allowMatched = allowCategories.length > 0
        ? await classifyTitle(title, allowCategories, allowCache, 'allow')
        : true;
    }

    const hide = blockMatched || !allowMatched;
    video.style.display = hide ? 'none' : '';
    if (hide) count++;
  }));

  hiddenCount = count;
  injectAddButtons();
}

function loadSettings(callback) {
  chrome.storage.sync.get(
    ['blockCategories', 'allowCategories', 'enabled', 'ollamaModel',
     'filteringMode', 'aiProvider', 'apiKey', 'apiBaseUrl', 'aiChannelFilter'],
    (data) => {
      const newBlock    = data.blockCategories || [];
      const newAllow    = data.allowCategories || [];
      const newModel    = data.ollamaModel    || 'qwen2.5-coder:7b';
      const newProvider = data.aiProvider     || 'ollama';
      const newApiKey   = data.apiKey         || '';
      const newBaseUrl  = data.apiBaseUrl     || 'https://api.openai.com/v1';
      const newAiCh     = !!data.aiChannelFilter;

      // Any change to the AI settings invalidates cached classification results
      const aiChanged =
        newModel    !== ollamaModel  ||
        newProvider !== aiProvider   ||
        newApiKey   !== apiKey       ||
        newBaseUrl  !== apiBaseUrl;

      if (JSON.stringify(newBlock) !== JSON.stringify(blockCategories) || aiChanged) {
        blockCache.clear();
        console.log('[YT Filter] Block cache cleared');
      }
      if (JSON.stringify(newAllow) !== JSON.stringify(allowCategories) || aiChanged) {
        allowCache.clear();
        console.log('[YT Filter] Allow cache cleared');
      }
      if (aiChanged || newAiCh !== aiChannelFilter) {
        channelSimilarityCache.clear();
        console.log('[YT Filter] Channel similarity cache cleared');
      }

      blockCategories = newBlock;
      allowCategories = newAllow;
      enabled         = data.enabled !== undefined ? data.enabled : true;
      ollamaModel     = newModel;
      filteringMode   = data.filteringMode || 'keyword';
      aiProvider      = newProvider;
      apiKey          = newApiKey;
      apiBaseUrl      = newBaseUrl;
      aiChannelFilter = newAiCh;

      if (callback) callback();
    }
  );
}

// Debounced observer
let filterTimer = null;
function scheduleFilter() {
  clearTimeout(filterTimer);
  filterTimer = setTimeout(filterVideos, 600);
}

const observer = new MutationObserver(scheduleFilter);

function startObserver() {
  observer.observe(document.body, { childList: true, subtree: true });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'UPDATE_FILTER') {
    loadSettings(() => filterVideos());
  }
  if (msg.type === 'GET_HIDDEN_COUNT') {
    sendResponse({ count: hiddenCount });
  }
  if (msg.type === 'GET_LOG') {
    sendResponse({ log: apiLog });
  }
  return true;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync') {
    loadSettings(() => filterVideos());
  }
  if (area === 'local' && (changes.savedVideos || changes.aiBlockedChannels)) {
    channelSimilarityCache.clear();
    // When manual saves change, clear AI recommendations so they re-evaluate
    if (changes.savedVideos) {
      chrome.storage.local.set({ aiBlockedChannels: [] });
      console.log('[YT Filter] Caches + AI recommendations cleared (savedVideos changed)');
    } else {
      console.log('[YT Filter] Channel similarity cache cleared (aiBlockedChannels changed)');
    }
    if (filteringMode === 'channel') filterVideos();
  }
});

loadSettings(() => {
  filterVideos();
  startObserver();
});

})();

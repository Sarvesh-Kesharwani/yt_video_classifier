const CLASSIFIER_BADGE_CLASS = "yt-local-llm-badge";

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "collectVideos") {
    collectVideos(message.settings)
      .then((videos) => sendResponse({ ok: true, videos }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "applyClassifications") {
    applyClassifications(message.classifications || []);
    sendResponse({ ok: true });
  }

  return undefined;
});

async function collectVideos(settings) {
  const includeTitle = Boolean(settings?.includeTitle);
  const includeDescription = Boolean(settings?.includeDescription);
  const includeTranscript = Boolean(settings?.includeTranscript);
  const maxVideos = Number(settings?.maxVideos || 30);

  const cardSelectors = [
    "ytd-rich-item-renderer",
    "ytd-video-renderer",
    "ytd-grid-video-renderer",
    "ytd-compact-video-renderer"
  ];

  const cards = Array.from(document.querySelectorAll(cardSelectors.join(", ")));
  const byVideoId = new Map();

  for (const card of cards) {
    const titleAnchor = card.querySelector("a#video-title");
    if (!titleAnchor) continue;

    const href = titleAnchor.getAttribute("href") || "";
    const url = toAbsoluteYouTubeUrl(href);
    const videoId = getVideoId(url);
    if (!videoId || byVideoId.has(videoId)) continue;

    const title = (titleAnchor.textContent || "").trim();

    const descriptionCandidates = [
      "#description-text",
      "#metadata-line",
      "yt-formatted-string#description-text",
      "#snippet-text",
      "#dismissible #description-text"
    ];

    let description = "";
    for (const selector of descriptionCandidates) {
      const el = card.querySelector(selector);
      if (el?.textContent?.trim()) {
        description = el.textContent.trim();
        break;
      }
    }

    byVideoId.set(videoId, {
      videoId,
      url,
      title,
      description,
      transcript: ""
    });

    if (byVideoId.size >= maxVideos) break;
  }

  const videos = Array.from(byVideoId.values());

  if (includeTranscript) {
    const concurrency = 3;
    for (let i = 0; i < videos.length; i += concurrency) {
      const chunk = videos.slice(i, i + concurrency);
      await Promise.all(
        chunk.map(async (video) => {
          video.transcript = await fetchTranscript(video.videoId);
        })
      );
    }
  }

  return videos.map((video) => ({
    ...video,
    textForClassification: buildText(video, { includeTitle, includeDescription, includeTranscript })
  }));
}

function buildText(video, flags) {
  const parts = [];
  if (flags.includeTitle && video.title) parts.push(`Title: ${video.title}`);
  if (flags.includeDescription && video.description) {
    parts.push(`Description: ${video.description}`);
  }
  if (flags.includeTranscript && video.transcript) {
    parts.push(`Transcript: ${video.transcript}`);
  }
  return parts.join("\n\n");
}

async function fetchTranscript(videoId) {
  try {
    const watchHtml = await fetch(`https://www.youtube.com/watch?v=${videoId}`).then((r) => r.text());

    const playerResponse = extractJson(watchHtml, "ytInitialPlayerResponse =", "};") ||
      extractJson(watchHtml, "var ytInitialPlayerResponse =", "};");

    if (!playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks?.length) {
      return "";
    }

    const captionTrack = playerResponse.captions.playerCaptionsTracklistRenderer.captionTracks[0];
    const transcriptXml = await fetch(captionTrack.baseUrl).then((r) => r.text());

    const xmlDoc = new DOMParser().parseFromString(transcriptXml, "text/xml");
    const nodes = Array.from(xmlDoc.querySelectorAll("text"));
    return nodes
      .map((node) => decodeHtmlEntities(node.textContent || ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  } catch (_error) {
    return "";
  }
}

function extractJson(source, prefix, endToken) {
  const start = source.indexOf(prefix);
  if (start === -1) return null;

  const jsonStart = source.indexOf("{", start);
  const end = source.indexOf(endToken, jsonStart);
  if (jsonStart === -1 || end === -1) return null;

  const raw = source.slice(jsonStart, end + 1);
  try {
    return JSON.parse(raw);
  } catch (_error) {
    return null;
  }
}

function decodeHtmlEntities(text) {
  const textarea = document.createElement("textarea");
  textarea.innerHTML = text;
  return textarea.value;
}

function toAbsoluteYouTubeUrl(href) {
  if (!href) return "";
  if (href.startsWith("http://") || href.startsWith("https://")) return href;
  return `https://www.youtube.com${href}`;
}

function getVideoId(urlString) {
  try {
    const url = new URL(urlString);
    return url.searchParams.get("v");
  } catch (_error) {
    return null;
  }
}

function applyClassifications(classifications) {
  clearExistingBadges();
  const map = new Map(classifications.map((item) => [item.videoId, item]));

  const cards = document.querySelectorAll(
    "ytd-rich-item-renderer, ytd-video-renderer, ytd-grid-video-renderer, ytd-compact-video-renderer"
  );

  for (const card of cards) {
    const titleAnchor = card.querySelector("a#video-title");
    if (!titleAnchor) continue;

    const videoId = getVideoId(toAbsoluteYouTubeUrl(titleAnchor.getAttribute("href") || ""));
    if (!videoId || !map.has(videoId)) continue;

    const result = map.get(videoId);
    const badge = document.createElement("span");
    badge.className = CLASSIFIER_BADGE_CLASS;
    badge.textContent = `Category: ${result.category}`;
    badge.style.display = "inline-block";
    badge.style.marginTop = "6px";
    badge.style.padding = "2px 8px";
    badge.style.borderRadius = "999px";
    badge.style.fontSize = "12px";
    badge.style.fontWeight = "600";
    badge.style.background = "#065fd4";
    badge.style.color = "white";

    const target =
      card.querySelector("#meta") ||
      card.querySelector("#details") ||
      titleAnchor.parentElement ||
      card;

    target.appendChild(badge);
  }
}

function clearExistingBadges() {
  document.querySelectorAll(`.${CLASSIFIER_BADGE_CLASS}`).forEach((node) => node.remove());
}

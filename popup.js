const DEFAULTS = {
  endpoint: "http://localhost:11434/api/generate",
  model: "llama3",
  categories: "Education, Entertainment, News",
  includeTitle: true,
  includeDescription: false,
  includeTranscript: false,
  maxVideos: 30
};

const form = {
  endpoint: document.getElementById("endpoint"),
  model: document.getElementById("model"),
  categories: document.getElementById("categories"),
  includeTitle: document.getElementById("includeTitle"),
  includeDescription: document.getElementById("includeDescription"),
  includeTranscript: document.getElementById("includeTranscript"),
  maxVideos: document.getElementById("maxVideos"),
  run: document.getElementById("run"),
  status: document.getElementById("status"),
  results: document.getElementById("results")
};

init().catch((error) => setStatus(`Failed to initialize: ${error.message}`));

async function init() {
  const data = await chrome.storage.sync.get(DEFAULTS);
  applyForm(data);
  form.run.addEventListener("click", onRun);
}

function applyForm(data) {
  form.endpoint.value = data.endpoint;
  form.model.value = data.model;
  form.categories.value = data.categories;
  form.includeTitle.checked = data.includeTitle;
  form.includeDescription.checked = data.includeDescription;
  form.includeTranscript.checked = data.includeTranscript;
  form.maxVideos.value = data.maxVideos;
}

function collectSettings() {
  return {
    endpoint: form.endpoint.value.trim(),
    model: form.model.value.trim(),
    categories: form.categories.value.trim(),
    includeTitle: form.includeTitle.checked,
    includeDescription: form.includeDescription.checked,
    includeTranscript: form.includeTranscript.checked,
    maxVideos: Number(form.maxVideos.value || DEFAULTS.maxVideos)
  };
}

async function onRun() {
  const settings = collectSettings();

  if (!settings.includeTitle && !settings.includeDescription && !settings.includeTranscript) {
    setStatus("Enable at least one input source: title, description, or transcript.");
    return;
  }

  const categories = settings.categories
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  if (categories.length < 2) {
    setStatus("Please provide at least two categories.");
    return;
  }

  await chrome.storage.sync.set(settings);

  setStatus("Collecting videos from current YouTube tab...");
  form.run.disabled = true;
  form.results.innerHTML = "";

  try {
    const tab = await getActiveTab();
    ensureYouTubeTab(tab);

    const collectResponse = await chrome.tabs.sendMessage(tab.id, {
      type: "collectVideos",
      settings
    });

    if (!collectResponse?.ok) {
      throw new Error(collectResponse?.error || "Could not collect videos from the page.");
    }

    const videos = collectResponse.videos.filter((video) => video.textForClassification);
    if (!videos.length) {
      setStatus("No loaded videos found (or selected fields were empty).");
      return;
    }

    setStatus(`Classifying ${videos.length} videos with local model...`);

    const classifications = [];
    for (let i = 0; i < videos.length; i += 1) {
      const video = videos[i];
      const category = await classifyWithLocalLLM(video, categories, settings);
      classifications.push({ videoId: video.videoId, category, title: video.title });
      setStatus(`Classified ${i + 1}/${videos.length}...`);
    }

    await chrome.tabs.sendMessage(tab.id, {
      type: "applyClassifications",
      classifications
    });

    renderResults(classifications);
    setStatus("Done. Badges were added to loaded YouTube videos.");
  } catch (error) {
    setStatus(`Error: ${error.message}`);
  } finally {
    form.run.disabled = false;
  }
}

async function classifyWithLocalLLM(video, categories, settings) {
  const prompt = [
    "You are a strict classifier.",
    `Possible categories: ${categories.join(", ")}`,
    "Return JSON only in this exact format: {\"category\":\"<one-category>\"}",
    "Choose exactly one category from the list. If uncertain, pick the closest option.",
    "",
    video.textForClassification
  ].join("\n");

  const response = await fetch(settings.endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: settings.model,
      prompt,
      stream: false,
      format: "json"
    })
  });

  if (!response.ok) {
    throw new Error(`Local LLM request failed (${response.status}).`);
  }

  const payload = await response.json();
  const raw = payload.response || payload.output || payload.text || "";
  const parsed = parseCategoryJson(raw, categories);

  return parsed || categories[0];
}

function parseCategoryJson(raw, categories) {
  try {
    const json = JSON.parse(raw);
    if (json?.category && categories.includes(json.category)) {
      return json.category;
    }
  } catch (_error) {
    // Best-effort fallback below.
  }

  const lowered = raw.toLowerCase();
  const hit = categories.find((category) => lowered.includes(category.toLowerCase()));
  return hit || null;
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tabs.length) {
    throw new Error("No active tab found.");
  }
  return tabs[0];
}

function ensureYouTubeTab(tab) {
  if (!tab.url || !tab.url.startsWith("https://www.youtube.com/")) {
    throw new Error("Open a YouTube page (https://www.youtube.com) and try again.");
  }
}

function setStatus(message) {
  form.status.textContent = message;
}

function renderResults(classifications) {
  form.results.innerHTML = "";
  for (const item of classifications) {
    const li = document.createElement("li");
    li.textContent = `[${item.category}] ${item.title || item.videoId}`;
    form.results.appendChild(li);
  }
}

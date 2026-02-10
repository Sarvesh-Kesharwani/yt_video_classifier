chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.set({
    endpoint: "http://localhost:11434/api/generate",
    model: "llama3",
    categories: "Education, Entertainment, News",
    includeTitle: true,
    includeDescription: false,
    includeTranscript: false,
    maxVideos: 30
  });
});

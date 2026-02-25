// Load saved settings
chrome.storage.sync.get(
  ['botToken', 'chatId', 'ghToken', 'ghOwner', 'ghRepo', 'ghPath'],
  ({ botToken, chatId, ghToken, ghOwner, ghRepo, ghPath }) => {
    if (botToken) document.getElementById('botToken').value = botToken;
    if (chatId) document.getElementById('chatId').value = chatId;
    if (ghToken) document.getElementById('ghToken').value = ghToken;
    if (ghOwner) document.getElementById('ghOwner').value = ghOwner;
    if (ghRepo) document.getElementById('ghRepo').value = ghRepo;
    if (ghPath) document.getElementById('ghPath').value = ghPath;
  }
);
chrome.storage.local.get('ocFlushIntervalMinutes', ({ ocFlushIntervalMinutes }) => {
  if (ocFlushIntervalMinutes) document.getElementById('flushInterval').value = ocFlushIntervalMinutes;
});

document.getElementById('save').addEventListener('click', () => {
  const botToken = document.getElementById('botToken').value.trim();
  const chatId = document.getElementById('chatId').value.trim();
  const ghToken = document.getElementById('ghToken').value.trim();
  const ghOwner = document.getElementById('ghOwner').value.trim();
  const ghRepo = document.getElementById('ghRepo').value.trim();
  const ghPath = document.getElementById('ghPath').value.trim() || 'reading-log.json';
  const flushInterval = parseInt(document.getElementById('flushInterval').value, 10) || 60;

  chrome.storage.sync.set({ botToken, chatId, ghToken, ghOwner, ghRepo, ghPath });
  chrome.storage.local.set({ ocFlushIntervalMinutes: flushInterval }, () => {
    // Tell background to reconfigure the alarm with the new interval
    chrome.runtime.sendMessage({ type: 'oc-reset-alarm', intervalMinutes: flushInterval });

    const msg = document.getElementById('saved-msg');
    msg.style.display = 'inline';
    setTimeout(() => { msg.style.display = 'none'; }, 2000);
  });
});

// Load saved settings
chrome.storage.sync.get(['botToken', 'chatId'], ({ botToken, chatId }) => {
  if (botToken) document.getElementById('botToken').value = botToken;
  if (chatId) document.getElementById('chatId').value = chatId;
});
chrome.storage.local.get('ocFlushIntervalMinutes', ({ ocFlushIntervalMinutes }) => {
  if (ocFlushIntervalMinutes) document.getElementById('flushInterval').value = ocFlushIntervalMinutes;
});

document.getElementById('save').addEventListener('click', () => {
  const botToken = document.getElementById('botToken').value.trim();
  const chatId = document.getElementById('chatId').value.trim();
  const flushInterval = parseInt(document.getElementById('flushInterval').value, 10) || 60;

  chrome.storage.sync.set({ botToken, chatId });
  chrome.storage.local.set({ ocFlushIntervalMinutes: flushInterval }, () => {
    // Tell background to reconfigure the alarm with the new interval
    chrome.runtime.sendMessage({ type: 'oc-reset-alarm', intervalMinutes: flushInterval });

    const msg = document.getElementById('saved-msg');
    msg.style.display = 'inline';
    setTimeout(() => { msg.style.display = 'none'; }, 2000);
  });
});

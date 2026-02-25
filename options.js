chrome.storage.sync.get(['botToken', 'chatId'], ({ botToken, chatId }) => {
  if (botToken) document.getElementById('botToken').value = botToken;
  if (chatId) document.getElementById('chatId').value = chatId;
});

document.getElementById('save').addEventListener('click', () => {
  const botToken = document.getElementById('botToken').value.trim();
  const chatId = document.getElementById('chatId').value.trim();
  chrome.storage.sync.set({ botToken, chatId }, () => {
    const msg = document.getElementById('saved-msg');
    msg.style.display = 'inline';
    setTimeout(() => { msg.style.display = 'none'; }, 2000);
  });
});

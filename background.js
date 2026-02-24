// Context menu
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'oc-highlight',
    title: '🦞 Highlight with OpenClaw',
    contexts: ['selection']
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'oc-highlight') return;
  const { botToken, chatId } = await chrome.storage.sync.get(['botToken', 'chatId']);
  if (!botToken || !chatId) return;
  const text = info.selectionText.trim();
  const msg = `highlight: "${text.slice(0, 300)}"\nsource: ${tab.url}`;
  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: msg })
  });
});

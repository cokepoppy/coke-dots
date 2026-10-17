export function getConversationState(conversation) {
  return {
    status: 'ready',
    messages: conversation.messages,
  };
}

export function renderConversation(container, conversation) {
  const state = getConversationState(conversation);
  if (state.messages.length === 0) {
    container.innerHTML = '<section class="empty-state"><h1>欢迎使用 Coke Agent</h1><p>选择一个会话，或开始新的对话。</p></section>';
    return;
  }
  container.innerHTML = state.messages.map(message => `<article class="message">${escapeHtml(message.text)}</article>`).join('');
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

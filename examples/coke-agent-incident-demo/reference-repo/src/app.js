import { renderConversation } from './conversation-view.js';

const panel = document.querySelector('#conversation');
const errorBanner = document.querySelector('#error-banner');

async function openCurrentConversation() {
  try {
    // The API returns null until the first message creates a conversation.
    const currentConversation = null;
    renderConversation(panel, currentConversation);
  } catch (error) {
    errorBanner.hidden = false;
    errorBanner.textContent = '会话暂时无法打开，请稍后重试。';
    console.error(error);
  }
}

document.addEventListener('DOMContentLoaded', () => { void openCurrentConversation(); });

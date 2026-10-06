import React from 'react';
import type { Snapshot } from '../shared/types.ts';
import { DotAvatar } from './DotAvatar.tsx';

export function DotOnboarding({ profile, onCustomize, onEditAppearance, onOpenScratchpad }: { profile: Snapshot['profile']; onCustomize: () => void; onEditAppearance: () => void; onOpenScratchpad: () => void }) {
  return <div className="dot-onboarding" data-testid="dot-onboarding">
    <h1 className="dot-onboarding-title">Hey! I’m your dot</h1>
    <button className="dot-conversation-identity" aria-label="打开你的 dot 设置" onClick={onCustomize}>
      <DotAvatar appearance={profile} className="dot-conversation-avatar" />
      <span>dot</span>
    </button>
    <time className="dot-conversation-time">Sep 29, 12:18 AM</time>
    <div className="dot-onboarding-messages" aria-label="Dot 欢迎对话">
      <article className="message dot"><p>Hey! I’m your dot</p></article>
      <article className="message dot"><p>Message or call me anytime. I’ll keep things moving, even when we’re not talking, and check in with updates or questions.</p></article>
      <article className="message dot"><p>What do you want to call me?</p></article>
      <article className="message dot onboarding-customize"><button onClick={onEditAppearance}>Customize your dot</button></article>
      <article className="message dot"><p>I’ll start looking for ways to help. Anything top of mind?</p></article>
      <article className="message dot onboarding-long-message"><p>I made us a scratchpad for projects and to-dos. I’ll keep it updated as we go. Here are a few things we can start with:</p><ul>
        <li>Try a controlled video-project test I prepared to help you judge what dot adds beyond Codex</li>
        <li>Check your thumbnail skill against the approved style, with a checklist for keeping future images clean and consistent</li>
      </ul></article>
      <button className="message onboarding-scratchpad-link" onClick={onOpenScratchpad}>Your Personal Scratchpad</button>
      <article className="message user"><p>I’ll just call you dot</p></article>
      <article className="message dot"><p>dot it is 🙂</p></article>
    </div>
  </div>;
}

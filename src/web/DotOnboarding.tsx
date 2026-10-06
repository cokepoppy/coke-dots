import React from 'react';
import type { Snapshot } from '../shared/types.ts';
import { DotAvatar } from './DotAvatar.tsx';

export function DotOnboarding({ profile, onCustomize, onEditSetup }: { profile: Snapshot['profile']; onCustomize: () => void; onEditSetup: () => void }) {
  return <div className="dot-onboarding" data-testid="dot-onboarding">
    <h1 className="dot-onboarding-title">Hey! I’m your dot</h1>
    <button className="dot-conversation-identity" aria-label="打开你的 dot 设置" onClick={onCustomize}>
      <DotAvatar appearance={profile} className="dot-conversation-avatar" />
      <span>dot</span>
    </button>
    <span className="dot-conversation-status">Thinking…</span>
    <time className="dot-conversation-time">Sep 30, 1:14 PM</time>
    <div className="dot-onboarding-messages" aria-label="Dot 欢迎对话">
      <article className="message dot"><p>Hey! I’m your dot</p></article>
      <article className="message dot"><p>Message or call me anytime. I’ll keep things moving, even when we’re not talking, and check in with updates or questions.</p></article>
      <article className="message dot"><p>What do you want to call me?</p></article>
      <article className="message dot onboarding-customize"><button onClick={onEditSetup}>Customize your dot</button></article>
      <article className="message user"><p>I’ll just call you dot</p></article>
      <article className="message dot"><p>dot it is 🙂</p></article>
    </div>
  </div>;
}

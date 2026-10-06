import React from 'react';
import type { Snapshot } from '../shared/types.ts';
import { DotAvatar } from './DotAvatar.tsx';
import { DotComputerChoice } from './DotComputerChoice.tsx';

export function DotOnboarding({ profile, computerAccess, onComputerAccess, onCustomize, onEditSetup }: { profile: Snapshot['profile']; computerAccess: Snapshot['computerAccess']; onComputerAccess: (enabled: boolean) => Promise<void>; onCustomize: () => void; onEditSetup: () => void }) {
  if (!computerAccess.configured) return <DotComputerChoice localComputer={computerAccess.localComputer} mode="onboarding" onSave={onComputerAccess} />;
  const dotName = profile.name.trim() && profile.name !== 'Dot' ? profile.name.trim() : 'dot';

  return <div className="dot-onboarding" data-testid="dot-onboarding">
    <h1 className="dot-onboarding-title">Hey! I’m your dot</h1>
    <button className="dot-conversation-identity" aria-label="打开你的 dot 设置" onClick={onCustomize}>
      <DotAvatar appearance={profile} className="dot-conversation-avatar" />
      <span>{dotName}</span>
    </button>
    <span className="dot-conversation-status">Thinking…</span>
    <time className="dot-conversation-time">Sep 30, 1:14 PM</time>
    <div className="dot-onboarding-messages" aria-label="Dot 欢迎对话">
      <article className="message dot"><p>Hey! I’m your dot</p></article>
      <article className="message dot"><p>Message or call me anytime. I’ll keep things moving, even when we’re not talking, and check in with updates or questions.</p></article>
      <article className="message dot"><p>Want to give me a name?</p></article>
      <article className="message dot onboarding-customize"><button onClick={onEditSetup}>
        <DotAvatar appearance={profile} small className="onboarding-customize-avatar" />
        <span>Customize your dot</span>
        <span className="onboarding-customize-chevron" aria-hidden="true">›</span>
      </button></article>
    </div>
  </div>;
}

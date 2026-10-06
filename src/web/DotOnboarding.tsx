import React, { useEffect, useState } from 'react';
import type { Snapshot } from '../shared/types.ts';
import { DotAvatar } from './DotAvatar.tsx';
import { DotComputerChoice } from './DotComputerChoice.tsx';

export function DotOnboarding({ profile, computerAccess, onComputerAccess, onEditSetup }: { profile: Snapshot['profile']; computerAccess: Snapshot['computerAccess']; onComputerAccess: (enabled: boolean) => Promise<void>; onEditSetup: () => void }) {
  const dotName = profile.name.trim() && profile.name !== 'Dot' ? profile.name.trim() : 'dot';
  const onboardingName = profile.onboardingCompletedName?.trim() || '';
  const nameWasChosen = Boolean(onboardingName && onboardingName.toLocaleLowerCase() !== 'dot');
  const [showNameAcknowledgement, setShowNameAcknowledgement] = useState(false);

  useEffect(() => {
    setShowNameAcknowledgement(false);
    if (!profile.onboardingCompletedAt || !nameWasChosen) return;
    const completedAt = Date.parse(profile.onboardingCompletedAt);
    const elapsed = Number.isFinite(completedAt) ? Date.now() - completedAt : 0;
    const remaining = Math.max(0, 5000 - elapsed);
    const timer = window.setTimeout(() => setShowNameAcknowledgement(true), remaining);
    return () => window.clearTimeout(timer);
  }, [profile.onboardingCompletedAt, onboardingName, nameWasChosen]);

  if (!computerAccess.configured) return <DotComputerChoice localComputer={computerAccess.localComputer} mode="onboarding" onSave={onComputerAccess} />;

  return <div className="dot-onboarding" data-testid="dot-onboarding">
    <h1 className="dot-onboarding-title">Hey! I’m your dot</h1>
    <button className="dot-conversation-identity" aria-label="打开你的 dot 设置" onClick={onEditSetup}>
      <DotAvatar appearance={profile} className="dot-conversation-avatar" />
      <span>{dotName}</span>
    </button>
    <span className="dot-conversation-status">Thinking…</span>
    <time className="dot-conversation-time">Sep 30, 1:14 PM</time>
    <div className="dot-onboarding-messages" aria-label="Dot 欢迎对话">
      <article className="message dot"><p>Hey! I’m your dot</p></article>
      <article className="message dot"><p>Message or call me anytime. I’ll keep things moving, even when we’re not talking, and check in with updates or questions.</p></article>
      {profile.onboardingCompletedAt && <article className="message dot"><p>Want to give me a name?</p></article>}
      <button className="onboarding-customize" type="button" onClick={onEditSetup}><span aria-hidden="true">◎</span> Customize your dot <span className="onboarding-customize-chevron" aria-hidden="true">›</span></button>
      {profile.onboardingCompletedAt && <>
        <article className="message dot"><p>I’ll start looking for ways to help. Anything top of mind?</p></article>
        <article className="message dot onboarding-suggestion-card" data-testid="onboarding-suggestion-card">
          <p>A few things I could take off your plate:</p>
          <div className="onboarding-suggestion-redaction" aria-label="视频中的建议内容无法辨认" role="img"><i /><i /><i /></div>
          <p>Want help with any of these?</p>
        </article>
        {showNameAcknowledgement && nameWasChosen && <article className="message dot" data-testid="onboarding-name-ack"><p>{onboardingName} it is! ❤️</p></article>}
      </>}
    </div>
  </div>;
}

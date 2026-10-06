import React from 'react';
import type { DotAppearance } from '../shared/types.ts';

export function DotAvatar({ appearance, small = false, className = '' }: { appearance: DotAppearance; small?: boolean; className?: string }) {
  const sizeClass = small ? 'small' : '';
  return <div
    className={`avatar ${appearance.shape} eyes-${appearance.eyes} glasses-${appearance.glasses} accessory-${appearance.accessory} ${sizeClass} ${className}`.trim()}
    style={{ '--avatar-color': appearance.color } as React.CSSProperties}
    aria-hidden="true"
  >
    <span className={`avatar-face ${appearance.shape}`} />
    <span className="avatar-eyes"><i /><i /></span>
    {appearance.glasses !== 'none' && <span className="avatar-glasses"><i /><i /></span>}
    {appearance.accessory !== 'none' && <span className="avatar-accessory" />}
  </div>;
}

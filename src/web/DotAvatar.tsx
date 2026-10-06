import React from 'react';
import type { DotAppearance } from '../shared/types.ts';
import { dotShapePath } from '../shared/avatar-shapes.ts';

export function DotAvatar({ appearance, small = false, className = '' }: { appearance: DotAppearance; small?: boolean; className?: string }) {
  const sizeClass = small ? 'small' : '';
  const usesCharacterArt = appearance.character !== 'ring' && appearance.character !== 'custom';
  return <div
    className={`avatar ${appearance.shape} character-${appearance.character} pet-${appearance.pet} eyes-${appearance.eyes} glasses-${appearance.glasses} accessory-${appearance.accessory} ${sizeClass} ${className}`.trim()}
    style={{ '--avatar-color': appearance.color } as React.CSSProperties}
    aria-hidden="true"
  >
    {usesCharacterArt ? <CharacterArt character={appearance.character} /> : appearance.character === 'ring'
      ? <span className={`avatar-face ${appearance.shape}`} />
      : <ShapeSilhouette shape={appearance.shape} className={`avatar-face avatar-face-svg ${appearance.shape}`} />}
    {appearance.character === 'custom' && <span className="avatar-eyes"><i /><i /></span>}
    {appearance.glasses !== 'none' && <span className="avatar-glasses"><i /><i /></span>}
    {appearance.accessory !== 'none' && <span className="avatar-accessory" />}
  </div>;
}

export function ShapeSilhouette({ shape, color, className = '' }: { shape: string; color?: string; className?: string }) {
  return <svg className={className} style={color ? { '--avatar-color': color } as React.CSSProperties : undefined} viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true" focusable="false">
    <path d={dotShapePath(shape)} fill="var(--avatar-color)" />
  </svg>;
}

function CharacterArt({ character }: { character: string }) {
  return <svg className={`avatar-face-art art-${character}`} viewBox="0 0 100 100" aria-hidden="true">
    {character === 'triangle' && <>
      <path fill="var(--avatar-color)" d="M50 8c-4 0-7 3-10 8L11 66c-6 10 1 22 13 22h52c12 0 19-12 13-22L60 16c-3-5-6-8-10-8Z" />
      <circle cx="39" cy="55" r="3.5" fill="#352d40" /><circle cx="61" cy="55" r="3.5" fill="#352d40" />
    </>}
    {character === 'blue' && <>
      <path fill="#f2c63d" d="M27 20 31 9l11 8 8-13 9 13 11-8 3 12Z" />
      <path fill="var(--avatar-color)" d="M48 17c-8 1-11 7-16 7-10 0-17 10-16 20-5 6-4 15 1 20-2 11 7 20 18 19 8 8 19 8 26 2 12 2 23-7 20-18 9-9 6-21-1-26 2-12-8-21-19-18-4-5-8-7-13-6Z" />
      <circle cx="39" cy="50" r="9" fill="#f8f5e9" /><circle cx="63" cy="50" r="9" fill="#f8f5e9" />
      <circle cx="41" cy="51" r="4.5" fill="#342b45" /><circle cx="61" cy="51" r="4.5" fill="#342b45" />
    </>}
    {character === 'smile' && <>
      <path fill="var(--avatar-color)" d="M50 13c19 0 35 15 35 34 0 20-16 39-35 39S15 67 15 47c0-19 16-34 35-34Z" />
      <circle cx="39" cy="47" r="3.5" fill="#263440" /><circle cx="61" cy="47" r="3.5" fill="#263440" />
      <path d="M38 59q12 12 24 0" fill="none" stroke="#263440" strokeWidth="3.5" strokeLinecap="round" />
    </>}
    {character === 'yellow' && <>
      <path fill="var(--avatar-color)" d="M50 10c7-8 16-1 17 7 11-4 18 5 14 15 11 7 8 17 1 22 8 11 1 20-9 20-3 12-14 15-23 8-10 7-20 3-22-7-13 1-18-9-11-19-9-8-5-18 2-22-5-12 2-20 13-17 2-10 12-14 18-7Z" />
      <circle cx="40" cy="49" r="3.5" fill="#3c3341" /><circle cx="61" cy="49" r="3.5" fill="#3c3341" />
    </>}
    {character === 'heart' && <>
      <path fill="var(--avatar-color)" d="M50 84 17 53C-1 35 11 12 30 14c9 1 15 7 20 14 5-7 11-13 20-14 19-2 31 21 13 39Z" />
      <path fill="#352d40" d="m38 47 4 4 4-4c3-3 8 1 5 5l-9 10-9-10c-3-4 2-8 5-5Zm20 0 4 4 4-4c3-3 8 1 5 5l-9 10-9-10c-3-4 2-8 5-5Z" />
    </>}
    {character === 'frog' && <>
      <path fill="var(--avatar-color)" d="M20 40c-5-10 2-20 12-20 8 0 13 6 15 13h6c2-7 7-13 15-13 10 0 17 10 12 20 8 6 12 16 9 27-4 13-18 21-39 21S15 80 11 67c-3-11 1-21 9-27Z" />
      <circle cx="34" cy="39" r="8" fill="#f4f2df" /><circle cx="66" cy="39" r="8" fill="#f4f2df" />
      <circle cx="35" cy="40" r="3.5" fill="#342b45" /><circle cx="65" cy="40" r="3.5" fill="#342b45" />
    </>}
    {character === 'flower' && <>
      <g fill="var(--avatar-color)"><circle cx="50" cy="21" r="16" /><circle cx="73" cy="34" r="16" /><circle cx="73" cy="61" r="16" /><circle cx="50" cy="76" r="16" /><circle cx="27" cy="61" r="16" /><circle cx="27" cy="34" r="16" /></g>
      <circle cx="50" cy="49" r="23" fill="var(--avatar-color)" />
      <circle cx="42" cy="48" r="3.5" fill="#342b45" /><circle cx="58" cy="48" r="3.5" fill="#342b45" />
    </>}
    {character === 'star' && <>
      <path fill="var(--avatar-color)" d="m50 7 12 27 30 3-22 20 7 30-27-16-27 16 7-30L8 37l30-3Z" />
      <circle cx="41" cy="48" r="3.5" fill="#342b45" /><circle cx="59" cy="48" r="3.5" fill="#342b45" />
    </>}
  </svg>;
}

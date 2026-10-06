import React, { useRef, useState } from 'react';
import type { DotAppearance } from '../shared/types.ts';
import { dotPets } from '../shared/avatar.ts';
import { DotAvatar } from './DotAvatar.tsx';

const characterPresets: { id: string; label: string; shape: string; eyes: string; glasses: string; accessory: string; swatchColor: string }[] = [
  { id: 'ring', label: 'Ring character', shape: 'circle', eyes: 'dot', glasses: 'none', accessory: 'none', swatchColor: '#c8cbd5' },
  { id: 'smile', label: 'Smiling character', shape: 'circle', eyes: 'happy', glasses: 'none', accessory: 'none', swatchColor: '#188a62' },
  { id: 'triangle', label: 'Triangle character', shape: 'triangle', eyes: 'classic', glasses: 'none', accessory: 'none', swatchColor: '#f18ac0' },
  { id: 'blue', label: 'Blue character', shape: 'blob', eyes: 'wide', glasses: 'none', accessory: 'crown', swatchColor: '#18a6da' },
  { id: 'yellow', label: 'Yellow character', shape: 'scallop', eyes: 'wide', glasses: 'none', accessory: 'none', swatchColor: '#f4c12d' },
  { id: 'heart', label: 'Heart character', shape: 'heart', eyes: 'sparkle', glasses: 'none', accessory: 'none', swatchColor: '#d174d7' },
  { id: 'frog', label: 'Frog character', shape: 'clover', eyes: 'wide', glasses: 'none', accessory: 'none', swatchColor: '#9dba24' },
  { id: 'flower', label: 'Flower character', shape: 'flower', eyes: 'classic', glasses: 'none', accessory: 'none', swatchColor: '#f58e70' },
  { id: 'star', label: 'Star character', shape: 'star', eyes: 'sparkle', glasses: 'none', accessory: 'none', swatchColor: '#f4c12d' },
];
const setupColors = ['#c8cbd5', '#08a7de', '#f4bd22', '#e47dc0', '#9abd1f', '#f18ac0', '#f58e70', '#22aaa3', '#5e81eb', '#8e65e8'];
const setupPets = dotPets.filter((pet): pet is Exclude<(typeof dotPets)[number], 'none'> => pet !== 'none');
const petLabels: Record<(typeof setupPets)[number], string> = { moss: 'Green pet', sky: 'Blue pet', aqua: 'Aqua pet', ember: 'Orange pet', sun: 'Yellow pet' };

export function DotSetupEditor({ profile, onClose, onSave }: {
  profile: { name: string } & DotAppearance;
  onClose: () => void;
  onSave: (appearance: DotAppearance, name: string) => Promise<void>;
}) {
  const [name, setName] = useState(profile.name === 'Dot' ? 'dot' : profile.name);
  const [appearance, setAppearance] = useState<DotAppearance>({ ...profile });
  const [saving, setSaving] = useState(false);
  const colorsRef = useRef<HTMLDivElement>(null);
  const charactersRef = useRef<HTMLDivElement>(null);
  const petsRef = useRef<HTMLDivElement>(null);

  function chooseCharacter(id: string) {
    const preset = characterPresets.find(item => item.id === id);
    if (!preset) return;
    setAppearance(current => ({ ...current, color: preset.swatchColor, character: preset.id, shape: preset.shape, eyes: preset.eyes, glasses: preset.glasses, accessory: preset.accessory }));
  }
  async function save() {
    setSaving(true);
    try { await onSave(appearance, name.trim()); } finally { setSaving(false); }
  }

  return <div className="avatar-editor-backdrop dot-setup-backdrop" data-testid="dot-setup-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="dot-setup-editor" role="dialog" aria-modal="true" aria-label="Customize your dot" onKeyDown={event => { if (event.key === 'Escape') onClose(); }}>
      <div className="dot-setup-controls">
        <h2>Customize your dot</h2>
        <SetupRow title="Colors" listRef={colorsRef}>
          {setupColors.map(color => <button key={color} type="button" className={`setup-choice setup-color-choice ${appearance.color.toLowerCase() === color ? 'selected' : ''}`} aria-label={`Color ${color}`} aria-pressed={appearance.color.toLowerCase() === color} onClick={() => setAppearance(current => ({ ...current, color }))}>
            <span className="setup-color-ring" style={{ '--swatch-color': color } as React.CSSProperties} />
          </button>)}
        </SetupRow>
        <SetupRow title="Characters" listRef={charactersRef}>
          {characterPresets.map(preset => <button key={preset.id} type="button" className={`setup-choice setup-character-choice ${appearance.character === preset.id ? 'selected' : ''}`} aria-label={preset.label} aria-pressed={appearance.character === preset.id} onClick={() => chooseCharacter(preset.id)}>
            <DotAvatar appearance={{ ...appearance, color: preset.swatchColor, shape: preset.shape, eyes: preset.eyes, glasses: preset.glasses, accessory: preset.accessory, character: preset.id, pet: 'none' }} small />
          </button>)}
        </SetupRow>
        <SetupRow title="Pets" listRef={petsRef}>
          {setupPets.map(pet => <button key={pet} type="button" className={`setup-choice setup-pet-choice ${appearance.pet === pet ? 'selected' : ''}`} aria-label={petLabels[pet]} aria-pressed={appearance.pet === pet} onClick={() => setAppearance(current => ({ ...current, pet }))}>
            <span className={`setup-pet-sprite pet-${pet}`}><i /><i /></span>
          </button>)}
        </SetupRow>
      </div>
      <aside className="dot-setup-preview" aria-label="Live preview">
        <button className="avatar-editor-close" type="button" aria-label="Close customizer" onClick={onClose}>×</button>
        <input aria-label="Dot name" maxLength={40} value={name} onChange={event => setName(event.target.value)} />
        <div className="dot-setup-avatar-preview"><DotAvatar appearance={appearance} /></div>
        <button className="avatar-editor-save" type="button" disabled={saving || !name.trim()} onClick={() => void save()}>{saving ? 'Saving…' : 'Save'}</button>
      </aside>
    </section>
  </div>;
}

function SetupRow({ title, listRef, children }: { title: string; listRef: React.RefObject<HTMLDivElement | null>; children: React.ReactNode }) {
  return <section className="dot-setup-row" aria-label={title}>
    <header><h3>{title}</h3><div><button type="button" aria-label={`Scroll ${title} left`} onClick={() => listRef.current?.scrollBy({ left: -150, behavior: 'smooth' })}>‹</button><button type="button" aria-label={`Scroll ${title} right`} onClick={() => listRef.current?.scrollBy({ left: 150, behavior: 'smooth' })}>›</button></div></header>
    <div className="dot-setup-row-items" ref={listRef}>{children}</div>
  </section>;
}

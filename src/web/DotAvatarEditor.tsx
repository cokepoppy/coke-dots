import React, { useState } from 'react';
import type { DotAppearance } from '../shared/types.ts';
import { dotAppearanceOptions, dotAvatarPalette } from '../shared/avatar.ts';
import { DotAvatar } from './DotAvatar.tsx';

type EditorTab = 'Shape' | 'Eyes' | 'Glasses' | 'Accessories';
const tabs: EditorTab[] = ['Shape', 'Eyes', 'Glasses', 'Accessories'];
const labels: Record<EditorTab, Record<string, string>> = {
  Shape: { circle: 'Circle', triangle: 'Triangle', capsule: 'Capsule', cat: 'Cat ears', flower: 'Flower', heart: 'Heart', clover: 'Clover', star: 'Star', scallop: 'Scallop', blob: 'Rounded shape', diamond: 'Diamond' },
  Eyes: { classic: 'Classic eyes', sleepy: 'Sleepy eyes', sparkle: 'Sparkle eyes', wink: 'Wink', wide: 'Wide eyes', happy: 'Happy eyes', heart: 'Heart eyes', dot: 'Dot eyes' },
  Glasses: { none: 'No glasses', round: 'Round glasses', square: 'Square glasses', oval: 'Oval glasses', thick: 'Thick glasses', winged: 'Winged glasses' },
  Accessories: { none: 'No accessory', crown: 'Crown', halo: 'Halo', bow: 'Bow', flower: 'Flower accessory', leaf: 'Leaf', sparkle: 'Sparkle accessory', antenna: 'Antenna', cap: 'Cap' },
};

export function DotAvatarEditor({ profile, onClose, onSave }: { profile: { name: string } & DotAppearance; onClose: () => void; onSave: (appearance: DotAppearance) => Promise<void> }) {
  const [appearance, setAppearance] = useState<DotAppearance>({ shape: profile.shape, color: profile.color, eyes: profile.eyes, glasses: profile.glasses, accessory: profile.accessory, character: profile.character, pet: profile.pet });
  const [activeTab, setActiveTab] = useState<EditorTab>('Shape');
  const [saving, setSaving] = useState(false);
  const options = activeTab === 'Shape' ? dotAppearanceOptions.shape
    : activeTab === 'Eyes' ? dotAppearanceOptions.eyes
      : activeTab === 'Glasses' ? dotAppearanceOptions.glasses : dotAppearanceOptions.accessory;
  const key = activeTab === 'Accessories' ? 'accessory' : activeTab.toLowerCase() as 'shape' | 'eyes' | 'glasses';
  const selected = appearance[key];
  function select(value: string) { setAppearance(current => ({ ...current, [key]: value, character: 'custom' })); }
  async function save() {
    setSaving(true);
    try { await onSave(appearance); } finally { setSaving(false); }
  }

  return <div className="avatar-editor-backdrop" data-testid="avatar-editor-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="avatar-editor" role="dialog" aria-modal="true" aria-label="Customize your dot" onKeyDown={event => { if (event.key === 'Escape') onClose(); }}>
      <div className="avatar-editor-controls">
        <div className="avatar-editor-tabs" role="tablist" aria-label="Dot appearance">
          <button type="button" className="avatar-editor-back" aria-label="Back to conversation" onClick={onClose}>←</button>
          {tabs.map(tab => <button key={tab} type="button" role="tab" aria-selected={activeTab === tab} className={activeTab === tab ? 'active' : ''} onClick={() => setActiveTab(tab)}>{tab}</button>)}
        </div>
        <div className={`avatar-editor-options ${activeTab === 'Shape' ? 'shape-options' : ''}`} role="group" aria-label={`${activeTab} options`}>
          {options.map(value => <button
            key={value}
            type="button"
            className={`avatar-option ${activeTab === 'Shape' ? 'shape-option' : ''} ${selected === value ? 'selected' : ''}`}
            aria-label={labels[activeTab][value]}
            aria-pressed={selected === value}
            title={labels[activeTab][value]}
            onClick={() => select(value)}
          >
            {activeTab === 'Shape'
              ? <span className={`avatar-shape-swatch ${value}`} style={{ backgroundColor: appearance.color }} />
              : <DotAvatar appearance={{
                ...appearance,
                shape: 'heart',
                color: '#77777b',
                eyes: activeTab === 'Eyes' ? value : 'classic',
                glasses: activeTab === 'Glasses' ? value : 'none',
                accessory: activeTab === 'Accessories' ? value : 'none',
                character: 'custom',
                pet: 'none',
              }} small />}
          </button>)}
        </div>
        {(activeTab === 'Shape' || activeTab === 'Accessories') && <div className="avatar-editor-colors" role="group" aria-label="Color">
          {dotAvatarPalette.map(color => <button
            key={color}
            type="button"
            className={appearance.color.toLowerCase() === color ? 'selected' : ''}
            style={{ backgroundColor: color }}
            aria-label={`Color ${color}`}
            aria-pressed={appearance.color.toLowerCase() === color}
            onClick={() => setAppearance(current => ({ ...current, color }))}
          />)}
        </div>}
      </div>
      <aside className="avatar-editor-preview" aria-label="Live preview">
        <button className="avatar-editor-close" type="button" aria-label="Close customizer" onClick={onClose}>×</button>
        <strong>{profile.name}</strong>
        <DotAvatar appearance={appearance} />
        <button className="avatar-editor-save" type="button" disabled={saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save'}</button>
      </aside>
    </section>
  </div>;
}

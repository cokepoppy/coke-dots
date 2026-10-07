export function computerWelcomePage(dotName = 'Dot') {
  const safeName = String(dotName).slice(0, 80).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  const icon = body => `<svg viewBox="0 0 36 36" aria-hidden="true">${body}</svg>`;
  const shortcuts = [
    { icon: icon('<circle cx="18" cy="18" r="14" fill="#e8ecee" stroke="#929ba2"/><circle cx="18" cy="18" r="10" fill="#b8c7d0"/><path d="M18 8v20M8 18h20M11 11l14 14M25 11 11 25" stroke="#67879a" stroke-width="1.5"/><path d="m18 9 5 5-5 4-5-4z" fill="#f2bf4b"/>'), label: '3D Slicer' },
    { icon: icon('<path d="M7 22c0-7 6-12 13-12 5 0 8 3 8 7 0 2-2 3-4 3-3 0-4 1-5 4-1 3-3 5-7 5-3 0-5-3-5-7Z" fill="#f5822b"/><path d="M8 16H3l8-5M11 10l5-5M16 27l-5 5" fill="none" stroke="#ed7621" stroke-width="3" stroke-linecap="round"/><circle cx="20" cy="17" r="4.5" fill="#3295cb" stroke="#fff" stroke-width="1.5"/>'), label: 'Blender' },
    { icon: icon('<path d="M7 13c0-4 4-7 10-7 6 0 11 3 11 8 0 7-8 15-13 15-3 0-4-2-3-5-4 0-7-3-7-7 0-2 1-3 2-4Z" fill="#f9f4e8" stroke="#8d8372" stroke-width="1.5"/><circle cx="12" cy="13" r="2" fill="#ef7b55"/><circle cx="19" cy="10" r="2" fill="#e6bd46"/><circle cx="24" cy="15" r="2" fill="#4d9ac1"/><circle cx="20" cy="22" r="2" fill="#67aa73"/>'), label: 'Draw' },
    { icon: icon('<path d="M8 5h20v5H14v5h11v5H14v10H8z" fill="#4093ce"/><path d="M22 5h7v5h-7zM14 15h9v5h-9z" fill="#e95845"/>'), label: 'FreeCAD' },
    { icon: icon('<path d="M6 14 11 8l5 2 4-3 8 6-2 12-8 4-10-5z" fill="#a5a6a2" stroke="#55585a" stroke-width="1.5"/><path d="m12 13 4 2 3-3 5 3-2 7-5 2-6-4z" fill="#d6d2c5"/><circle cx="14" cy="18" r="1.4" fill="#202226"/><circle cx="22" cy="17" r="1.4" fill="#202226"/><path d="m16 22 3 1 2-2" fill="none" stroke="#292a2a" stroke-width="1.3" stroke-linecap="round"/>'), label: 'GIMP' },
    { icon: icon('<rect x="4" y="4" width="28" height="28" rx="4" fill="#f5f5f2" stroke="#dddcd7"/><path d="M12 8v20M20 8v20M28 8v20M8 12h20M8 20h20M8 28h20" stroke="#bbbcb9" stroke-width="1"/><circle cx="23" cy="13" r="5" fill="#17191c"/>'), label: 'Go' },
    { icon: icon('<path d="M9 8 18 4l9 4 4 11-7 12H12L5 20z" fill="#4f9fc7" stroke="#326e96" stroke-width="1.5"/><circle cx="14" cy="16" r="2" fill="#f2f5f6"/><circle cx="22" cy="16" r="2" fill="#f2f5f6"/><path d="M13 23q5 5 10 0" fill="none" stroke="#f2f5f6" stroke-width="2" stroke-linecap="round"/>'), label: 'Godot' },
    { icon: icon('<path d="M5 26 16 8l4 7 4-4 8 15z" fill="#252629"/><path d="m16 8 5 13-8-3z" fill="#070809"/><path d="m6 27 11-3 14 3" fill="none" stroke="#55575a" stroke-width="1.4"/>'), label: 'Inkscape' },
    { icon: icon('<path d="m4 10 10-5 17 9-11 6z" fill="#84b2d0"/><path d="m4 10 16 10v11L4 22z" fill="#d9e8f0"/><path d="m20 20 11-6v12l-11 5z" fill="#4786ad"/><path d="m15 13 10 6-10 6z" fill="#f8fbfc"/>'), label: 'Kdenlive' },
    { icon: icon('<rect x="3" y="3" width="30" height="30" rx="4" fill="#416ba7"/><text x="6" y="24" fill="#fff" font-size="14" font-family="Arial,sans-serif" font-weight="700">Ki</text><path d="M23 13v12m0-6 6-6m-6 6 6 6" fill="none" stroke="#fff" stroke-width="2"/>'), label: 'KiCad' },
    { icon: '✦', label: '' }, { icon: '⌂', label: '' }, { icon: '●', label: '' }, { icon: '✧', label: '' }, { icon: '◈', label: '' },
  ];
  const doodles = `<svg class="pattern" viewBox="0 0 1252 795" preserveAspectRatio="none" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <g transform="translate(137 42)"><path d="M5 16 2 3q0-3 3-2l8 11M22 12l5-10q2-3 4 0l-2 14M4 18q0 12 12 12t13-12q0-6-7-6h-6q-12 0-12 6Z"/></g>
    <g transform="translate(294 34)"><path d="M2 16q3-13 14-13t15 13q-14 9-29 0ZM12 18l-2 12m8-12 3 12m-11 0h13"/></g>
    <path d="M752 38c0 8-10 17-10 23a10 10 0 0 0 20 0c0-6-10-15-10-23Z" transform="translate(0 -8)"/>
    <g transform="translate(1007 80)"><path d="M4 15 8 7l6 3 7-5 7 8-2 14-10 4-10-5zM11 8 9 2l6 4m8 1 2-6 3 7"/></g>
    <path d="M188 154c0 8-10 17-10 23a10 10 0 0 0 20 0c0-6-10-15-10-23Z"/>
    <g transform="translate(425 145)"><path d="M15 30V12M15 20Q4 19 3 9q10-1 12 8m1-3q1-10 12-12 1 11-10 14"/></g>
    <g transform="translate(87 240)"><circle cx="18" cy="18" r="16"/><circle cx="18" cy="18" r="2"/><path d="m18 2v32M2 18h32M7 7l22 22M29 7 7 29"/></g>
    <g transform="translate(330 237)"><path d="M4 16 2 5q0-3 3-1l8 10M22 14l5-10q2-3 4 0l-2 13M4 18q0 12 12 12t13-12q0-6-7-6h-6q-12 0-12 6Z"/></g>
    <path d="M902 245c0 8-10 17-10 23a10 10 0 0 0 20 0c0-6-10-15-10-23Z"/>
    <g transform="translate(1107 248)"><path d="M3 18q9-17 24-12-2 17-22 21M7 27 25 9"/></g>
    <g transform="translate(284 390)"><path d="M2 17q3-13 14-13t15 13q-14 9-29 0ZM12 19l-2 12m8-12 3 12m-11 0h13"/></g>
    <g transform="translate(1005 414)"><path d="M16 31V10M16 21Q5 21 3 10q10-2 13 8m2-5q2-10 13-10 0 11-12 14"/></g>
    <g transform="translate(113 448)"><path d="M3 17q0-10 9-10 2-6 8-2 8 0 8 8 7 6 1 13-8 4-15 0-11 4-11-9Z"/></g>
    <path d="M1154 582c0 8-10 17-10 23a10 10 0 0 0 20 0c0-6-10-15-10-23Z"/>
    <g transform="translate(1060 650)"><path d="M4 20Q8 6 22 3q0 14-14 22m-2 4L22 8"/></g>
  </g></svg>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Welcome back, ${safeName}</title>
  <style>
    *{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden}body{font-family:Arial,Helvetica,sans-serif;background:#f9f4f2;color:#222}
    .wallpaper{position:absolute;inset:0;background:#f9f4f2;overflow:hidden}.pattern{position:absolute;inset:0;width:100%;height:100%;color:#e8e5e1;opacity:.78;pointer-events:none}
    main{position:absolute;top:12%;left:50%;transform:translateX(-50%);width:min(620px,80%);text-align:center}.welcome-note{position:relative;display:grid;align-content:center;width:min(276px,60%);height:96px;margin:0 auto 7px;padding:14px 24px;border:1px solid #efedeb;border-radius:9px;background:#fff;box-shadow:0 2px 6px #0000000a}.welcome-note::after{content:"";position:absolute;left:64%;bottom:-9px;border-top:10px solid #fff;border-left:10px solid transparent;border-right:10px solid transparent}.welcome-note p{margin:0;color:#47444a;text-align:left;font-size:12px;line-height:1.2}.welcome-note b{position:absolute;right:11px;top:8px;color:#b9b5b7;font-size:10px;font-weight:400;line-height:1}.mascot{position:relative;width:110px;height:110px;margin:0 auto 2px;border-radius:48% 50% 44% 47%;background:#f27635;box-shadow:inset -7px -7px 0 #e96a2d;transform:rotate(-4deg)}.crown{position:absolute;top:-18px;left:30px;width:50px;height:30px;background:#f4c744;clip-path:polygon(0 100%,0 28%,25% 54%,39% 0,54% 55%,75% 7%,84% 59%,100% 32%,92% 100%)}.glasses{position:absolute;top:38px;left:15px;display:flex;gap:8px}.glasses i{display:block;width:34px;height:24px;border-radius:5px;background:#17191d;border:1px solid #35383b}.glasses b{width:7px;height:3px;background:#17191d;margin-top:10px}
    .remaining{position:relative;display:inline-block;font-size:80px;line-height:1.1;letter-spacing:-3px;font-weight:400;margin:0;color:#242329}.meridiem{position:absolute;right:-23px;bottom:7px;font-size:10px;line-height:1;letter-spacing:0;color:#77737a}.welcome{font-size:22px;color:#68666d;margin-top:12px}.shortcuts{display:grid;grid-template-columns:repeat(5,90px);justify-content:center;gap:29px 15px;margin:72px auto 0}.shortcut{height:105px;display:grid;justify-items:center;align-content:start;gap:10px;color:#6e6c73;font-size:10px;white-space:nowrap}.shortcut-icon{height:40px;width:40px;display:grid;place-items:center;color:#7b7780;font-size:25px;font-weight:600}.shortcut-icon svg{display:block;width:34px;height:34px;overflow:visible}
    @media(max-width:720px){main{top:8%;width:92%}.welcome-note{height:72px;margin-bottom:9px}.shortcuts{grid-template-columns:repeat(5,48px);gap:12px 6px;margin-top:35px}.remaining{font-size:68px}.mascot{width:94px;height:94px}}
  </style></head><body><div class="wallpaper">${doodles}</div>
    <main><div class="welcome-note"><p>This is my computer. Watch me work, or take control when you need to.</p><b aria-hidden="true">×</b></div><div class="mascot" aria-hidden="true"><span class="crown"></span><span class="glasses"><i></i><b></b><i></i></span></div><div class="remaining">1:19<span class="meridiem">PM</span></div><div class="welcome">Welcome back, ${safeName}</div>
      <div class="shortcuts" aria-hidden="true">${shortcuts.map(({ icon, label }) => `<div class="shortcut"><span class="shortcut-icon">${icon}</span>${label ? `<span class="shortcut-label">${label}</span>` : ''}</div>`).join('')}</div>
    </main></body></html>`;
}

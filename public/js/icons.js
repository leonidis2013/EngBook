// EngBook — thin-line drafting icons (1.5 px stroke).
// Copyright (c) 2026 Jerod Ulicki
const svg = (d, extra = '') => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"${extra}>${d}</svg>`;

export const ICONS = {
  menu: svg('<path d="M4 7h16M4 12h16M4 17h16"/>'),
  undo: svg('<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 010 12h-3"/>'),
  redo: svg('<path d="M15 14l5-5-5-5"/><path d="M20 9H10a6 6 0 000 12h3"/>'),
  page: svg('<rect x="5" y="3" width="14" height="18" rx="1"/><path d="M8 8h8M8 12h8M8 16h5"/>'),
  grid: svg('<rect x="4" y="4" width="16" height="16" rx="1"/><path d="M4 9.33h16M4 14.67h16M9.33 4v16M14.67 4v16"/>'),
  export: svg('<path d="M12 3v12M7 8l5-5 5 5"/><path d="M5 14v6h14v-6"/>'),
  gear: svg('<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  more: svg('<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>'),
  chevron: svg('<path d="M9 6l6 6-6 6"/>'),
  notebook: svg('<rect x="5" y="3" width="14" height="18" rx="1.5"/><path d="M9 3v18"/>'),
  section: svg('<path d="M4 6h7l2 2h7v11H4z"/>'),
  eraser: svg('<path d="M15.5 4.5l4 4L10 18H6l-2-2 11.5-11.5z"/><path d="M12.5 7.5l4 4M10 18h10"/>'),
  fineliner: svg('<path d="M4 20l1.5-4.5L16 5l3 3L8.5 18.5z"/><path d="M14 7l3 3"/>'),
  tech: svg('<path d="M4 20l2-2"/><path d="M6 18l2-5 7-7 3 3-7 7z"/><path d="M13 8l3 3"/>'),
  pencil: svg('<path d="M4 20l1-4L16.5 4.5a2 2 0 013 3L8 19z"/><path d="M14.5 6.5l3 3"/>'),
  redline: svg('<path d="M4 20l1.5-4.5L16 5l3 3L8.5 18.5z"/><path d="M3 21h8" stroke-width="2"/>'),
  highlighter: svg('<path d="M9 14l6-10 4 2.5-6 10z"/><path d="M9 14l-1.5 3.5 3 1.5 2.5-3.5"/><path d="M4 21h7"/>'),
  sync: svg('<path d="M4 12a8 8 0 0114-5.3M20 12a8 8 0 01-14 5.3"/><path d="M18 3v4h-4M6 21v-4h4"/>'),
  search: svg('<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>'),
  pin: svg('<path d="M12 17v4M8 3h8l-1 6 3 3H6l3-3z"/>'),
  eye: svg('<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z"/><circle cx="12" cy="12" r="2.5"/>'),
  key: svg('<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l2 2M15 8l2 2"/>'),
  logout: svg('<path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10"/>'),
  fit: svg('<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/>'),
  compare: svg('<path d="M12 3v18"/><path d="M4 8c2-2 4 2 6 0M14 8c2-2 4 2 6 0M4 16h6M14 16h6"/>'),
  hand: svg('<path d="M8 13V5.5a1.5 1.5 0 013 0V11M11 10.5V4a1.5 1.5 0 013 0v6.5M14 10.5V5.5a1.5 1.5 0 013 0V14a7 7 0 01-7 7h-.5a6 6 0 01-4.6-2.2L3 16.2a1.6 1.6 0 012.4-2.1L8 16"/>'),
  lock: svg('<rect x="5" y="11" width="14" height="10" rx="1"/><path d="M8 11V8a4 4 0 018 0v3"/>'),
};

export function icon(name) {
  const span = document.createElement('span');
  span.className = 'ic';
  span.innerHTML = ICONS[name] || '';
  return span;
}

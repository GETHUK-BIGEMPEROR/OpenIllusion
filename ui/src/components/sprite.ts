// Icon sprite, drawn once in the app frame; <I n="…"/> references a symbol by name.
export const SPRITE = `<symbol id="i-compass" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9.5"/><path d="m15.8 8.2-2.1 5.5-5.5 2.1 2.1-5.5z"/></symbol>
<symbol id="i-wand" viewBox="0 0 24 24"><path d="m4 20 10-10"/><path d="m15.5 3 .9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z"/><path d="m19.5 11 .5 1.2 1.2.5-1.2.5-.5 1.2-.5-1.2-1.2-.5 1.2-.5z"/><path d="m8.5 3.5.5 1.2 1.2.5-1.2.5-.5 1.2-.5-1.2-1.2-.5 1.2-.5z"/></symbol>
<symbol id="i-library" viewBox="0 0 24 24"><rect x="3" y="3" width="7.5" height="10" rx="2"/><rect x="13.5" y="3" width="7.5" height="6" rx="2"/><rect x="13.5" y="12" width="7.5" height="9" rx="2"/><rect x="3" y="16" width="7.5" height="5" rx="2"/></symbol>
<symbol id="i-layers" viewBox="0 0 24 24"><path d="m12 2.5 9.5 4.8-9.5 4.8-9.5-4.8z"/><path d="m2.5 12 9.5 4.8 9.5-4.8"/><path d="m2.5 16.7 9.5 4.8 9.5-4.8"/></symbol>
<symbol id="i-sliders" viewBox="0 0 24 24"><path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/></symbol>
<symbol id="i-search" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7.5"/><path d="m20.5 20.5-4.2-4.2"/></symbol>
<symbol id="i-import" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/></symbol>
<symbol id="i-upload" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/></symbol>
<symbol id="i-plus" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></symbol>
<symbol id="i-x" viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></symbol>
<symbol id="i-more" viewBox="0 0 24 24"><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/><circle cx="5" cy="12" r="1.2"/></symbol>
<symbol id="i-refresh" viewBox="0 0 24 24"><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M8 16H3v5"/></symbol>
<symbol id="i-info" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9.5"/><path d="M12 16v-4M12 8h.01"/></symbol>
<symbol id="i-check" viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></symbol>
<symbol id="i-alert" viewBox="0 0 24 24"><path d="m21.7 18-8-14a2 2 0 0 0-3.4 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3"/><path d="M12 9v4M12 17h.01"/></symbol>
<symbol id="i-down" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></symbol>
<symbol id="i-left" viewBox="0 0 24 24"><path d="m15 18-6-6 6-6"/></symbol>
<symbol id="i-right" viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"/></symbol>
<symbol id="i-arrow" viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></symbol>
<symbol id="i-back" viewBox="0 0 24 24"><path d="m12 19-7-7 7-7M19 12H5"/></symbol>
<symbol id="i-play" viewBox="0 0 24 24"><path d="M7 4.5v15l12.5-7.5z"/></symbol>
<symbol id="i-copy" viewBox="0 0 24 24"><rect x="8" y="8" width="13" height="13" rx="2.5"/><path d="M4 16a2 2 0 0 1-1-1.7V5a2 2 0 0 1 2-2h9.3A2 2 0 0 1 16 4"/></symbol>
<symbol id="i-trash" viewBox="0 0 24 24"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></symbol>
<symbol id="i-cpu" viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="2.5"/><rect x="9" y="9" width="6" height="6" rx="1"/><path d="M15 2v2M15 20v2M2 15h2M2 9h2M20 15h2M20 9h2M9 2v2M9 20v2"/></symbol>
<symbol id="i-cloud" viewBox="0 0 24 24"><path d="M17.5 19H9a7 7 0 1 1 6.7-9h1.8a4.5 4.5 0 1 1 0 9z"/></symbol>
<symbol id="i-compare" viewBox="0 0 24 24"><path d="M8 7 3 12l5 5M16 7l5 5-5 5"/></symbol>
<symbol id="i-remix" viewBox="0 0 24 24"><path d="M2 18h1.4c1.3 0 2.5-.6 3.3-1.7l6.1-8.6c.7-1.1 2-1.7 3.3-1.7H22"/><path d="m18 2 4 4-4 4"/><path d="M2 6h1.9c1.5 0 2.9.9 3.6 2.2"/><path d="M22 18h-5.9c-1.3 0-2.6-.7-3.3-1.8l-.5-.8"/><path d="m18 14 4 4-4 4"/></symbol>
<symbol id="i-pencil" viewBox="0 0 24 24"><path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/></symbol>
<symbol id="i-image" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2.5"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/></symbol>
<symbol id="i-film" viewBox="0 0 24 24"><path d="m16 13 5.2 3.5a.5.5 0 0 0 .8-.4V7.9a.5.5 0 0 0-.8-.4L16 11"/><rect x="2" y="6" width="14" height="12" rx="2"/></symbol>
<symbol id="i-share" viewBox="0 0 24 24"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><path d="m16 6-4-4-4 4"/><path d="M12 2v13"/></symbol>
<symbol id="i-select" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="m8.5 12 2.5 2.5 4.5-5"/></symbol>
<symbol id="i-key" viewBox="0 0 24 24"><circle cx="7.5" cy="15.5" r="5"/><path d="m21 2-9.6 9.6M15.5 7.5l3 3L22 7l-3-3"/></symbol>
<symbol id="i-globe" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9.5"/><path d="M2.5 12h19M12 2.5a14.5 14.5 0 0 1 0 19 14.5 14.5 0 0 1 0-19"/></symbol>
<symbol id="i-zap" viewBox="0 0 24 24"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></symbol>
<symbol id="i-clock" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9.5"/><path d="M12 7v5l3 2"/></symbol>
<symbol id="i-expand" viewBox="0 0 24 24"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></symbol>
<symbol id="i-grid" viewBox="0 0 24 24"><rect x="3" y="3" width="7.5" height="7.5" rx="1.5"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5"/></symbol>
<symbol id="i-undo" viewBox="0 0 24 24"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></symbol>
<symbol id="i-star" viewBox="0 0 24 24"><path d="m12 2.8 2.8 5.8 6.4.9-4.6 4.5 1.1 6.4L12 17.4l-5.7 3 1.1-6.4-4.6-4.5 6.4-.9z"/></symbol>
<symbol id="i-download" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/></symbol>
<symbol id="i-graph" viewBox="0 0 24 24"><rect x="2.5" y="3" width="7" height="6" rx="1.5"/><rect x="14.5" y="15" width="7" height="6" rx="1.5"/><path d="M9.5 6H13a2 2 0 0 1 2 2v7"/></symbol>`;

export type IconName = "compass" | "wand" | "library" | "layers" | "sliders" | "search" | "import" | "upload" | "plus" | "x" | "more" | "refresh" | "info" | "check" | "alert" | "down" | "left" | "right" | "arrow" | "back" | "play" | "copy" | "trash" | "cpu" | "cloud" | "compare" | "remix" | "pencil" | "image" | "film" | "share" | "select" | "key" | "globe" | "zap" | "clock" | "expand" | "grid" | "undo" | "star" | "download" | "graph";

import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement> & { size?: number };

const base = (size = 20, sw = 1.6): SVGProps<SVGSVGElement> => ({
  width: size,
  height: size,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: sw,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
});

export const Library = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <rect x="3" y="4" width="7" height="7" rx="2.5" /><rect x="14" y="4" width="7" height="7" rx="2.5" />
    <rect x="3" y="14" width="7" height="7" rx="2.5" /><rect x="14" y="14" width="7" height="7" rx="2.5" />
  </svg>
);
export const Motion = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <rect x="3" y="5" width="18" height="14" rx="4" /><path d="M10 9.5v5l4.5-2.5z" fill="currentColor" />
  </svg>
);
export const Brush = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="M4 20c2.5 0 4-1.2 4-3.5 0-1.4 1-2.5 2.4-2.5" /><path d="M10.4 14 19 5.4a1.9 1.9 0 0 0-2.7-2.7L7.7 11.3" /><path d="M7.7 11.3 10.4 14" />
  </svg>
);
export const Queue = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="M8 6h13M8 12h13M8 18h13" /><circle cx="4" cy="6" r="1" /><circle cx="4" cy="12" r="1" /><circle cx="4" cy="18" r="1" />
  </svg>
);
export const Sliders = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="M4 7h10M18 7h2M4 17h4M12 17h8" /><circle cx="16" cy="7" r="2" /><circle cx="10" cy="17" r="2" />
  </svg>
);
export const Search = ({ size = 15, ...p }: P) => (
  <svg {...base(size, 1.8)} {...p}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
);
export const Download = ({ size = 15, ...p }: P) => (
  <svg {...base(size, 1.8)} {...p}><path d="M12 4v11M7 10l5 5 5-5M5 20h14" /></svg>
);
export const Upload = ({ size = 15, ...p }: P) => (
  <svg {...base(size, 1.8)} {...p}><path d="M12 20V9M7 14l5-5 5 5M5 4h14" /></svg>
);
export const Close = ({ size = 13, ...p }: P) => (
  <svg {...base(size, 2.4)} {...p}><path d="m7 7 10 10M17 7 7 17" /></svg>
);
export const Plus = ({ size = 14, ...p }: P) => (
  <svg {...base(size, 2)} {...p}><path d="M12 5v14M5 12h14" /></svg>
);
export const Check = ({ size = 14, ...p }: P) => (
  <svg {...base(size, 2.4)} {...p}><path d="m5 12 5 5 9-10" /></svg>
);
export const Dash = ({ size = 14, ...p }: P) => (
  <svg {...base(size, 2.4)} {...p}><path d="M6 12h12" /></svg>
);
export const Chevron = ({ size = 16, ...p }: P) => (
  <svg {...base(size, 1.8)} {...p}><path d="m6 9 6 6 6-6" /></svg>
);
export const ChevronRight = ({ size = 14, ...p }: P) => (
  <svg {...base(size, 1.8)} {...p}><path d="m9 6 6 6-6 6" /></svg>
);
export const ArrowLeft = ({ size = 14, ...p }: P) => (
  <svg {...base(size, 1.8)} {...p}><path d="M19 12H5M11 6l-6 6 6 6" /></svg>
);
export const Dice = ({ size = 15, ...p }: P) => (
  <svg {...base(size, 1.8)} {...p}>
    <rect x="4" y="4" width="16" height="16" rx="4" />
    <circle cx="9" cy="9" r="1" fill="currentColor" /><circle cx="15" cy="15" r="1" fill="currentColor" /><circle cx="15" cy="9" r="1" fill="currentColor" /><circle cx="9" cy="15" r="1" fill="currentColor" />
  </svg>
);
export const Play = ({ size = 14, ...p }: P) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden {...p}><path d="M7 4.5v15l13-7.5z" fill="currentColor" /></svg>
);
export const Pause = ({ size = 14, ...p }: P) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden {...p}><rect x="6" y="4.5" width="4" height="15" rx="1.2" fill="currentColor" /><rect x="14" y="4.5" width="4" height="15" rx="1.2" fill="currentColor" /></svg>
);
export const Info = ({ size = 16, ...p }: P) => (
  <svg {...base(size, 1.8)} {...p}><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></svg>
);
export const Lock = ({ size = 14, ...p }: P) => (
  <svg {...base(size, 1.8)} {...p}><rect x="5" y="11" width="14" height="9" rx="3" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>
);
export const Star = ({ size = 14, filled, ...p }: P & { filled?: boolean }) => (
  <svg {...base(size, 1.8)} fill={filled ? "currentColor" : "none"} {...p}>
    <path d="m12 3.5 2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.8z" />
  </svg>
);
export const Trash = ({ size = 14, ...p }: P) => (
  <svg {...base(size, 1.8)} {...p}><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" /></svg>
);
export const Link = ({ size = 14, ...p }: P) => (
  <svg {...base(size, 1.8)} {...p}><path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1" /><path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1" /></svg>
);
export const Copy = ({ size = 14, ...p }: P) => (
  <svg {...base(size, 1.8)} {...p}><rect x="8" y="8" width="12" height="12" rx="3" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></svg>
);
export const Graph = ({ size = 14, ...p }: P) => (
  <svg {...base(size, 1.8)} {...p}><rect x="3" y="4" width="7" height="6" rx="2" /><rect x="14" y="14" width="7" height="6" rx="2" /><path d="M10 7h3a2 2 0 0 1 2 2v5" /></svg>
);
export const Box = ({ size = 14, ...p }: P) => (
  <svg {...base(size, 1.8)} {...p}><rect x="4" y="4" width="16" height="16" rx="3" strokeDasharray="3 3" /></svg>
);
export const Frame = ({ size = 14, ...p }: P) => (
  <svg {...base(size, 1.8)} {...p}><rect x="3" y="5" width="18" height="14" rx="3" /><path d="m3 15 5-4 4 3 3-2 6 4" /></svg>
);
export const Folder = ({ size = 14, ...p }: P) => (
  <svg {...base(size, 1.8)} {...p}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>
);
export const Ban = ({ size = 18, ...p }: P) => (
  <svg {...base(size, 1.8)} {...p}><circle cx="12" cy="12" r="9" /><path d="m6 6 12 12" /></svg>
);
export const AlertTriangle = ({ size = 16, ...p }: P) => (
  <svg {...base(size, 1.8)} {...p}><path d="M10.3 4.3 2.9 17.5A2 2 0 0 0 4.6 20.5h14.8a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0z" /><path d="M12 9.5v4M12 17h.01" /></svg>
);
export const CheckCircle = ({ size = 16, ...p }: P) => (
  <svg {...base(size, 1.8)} {...p}><circle cx="12" cy="12" r="9" /><path d="m8.5 12.2 2.4 2.4 4.6-5" /></svg>
);
export const XCircle = ({ size = 16, ...p }: P) => (
  <svg {...base(size, 1.8)} {...p}><circle cx="12" cy="12" r="9" /><path d="m9.2 9.2 5.6 5.6M14.8 9.2l-5.6 5.6" /></svg>
);
export const Refresh = ({ size = 14, ...p }: P) => (
  <svg {...base(size, 1.8)} {...p}><path d="M20 11a8 8 0 0 0-14.6-4.5M4 4v4h4M4 13a8 8 0 0 0 14.6 4.5M20 20v-4h-4" /></svg>
);
export const External = ({ size = 13, ...p }: P) => (
  <svg {...base(size, 1.8)} {...p}><path d="M14 4h6v6M20 4l-9 9M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" /></svg>
);
export const More = ({ size = 16, ...p }: P) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden {...p}><circle cx="5" cy="12" r="1.6" fill="currentColor" /><circle cx="12" cy="12" r="1.6" fill="currentColor" /><circle cx="19" cy="12" r="1.6" fill="currentColor" /></svg>
);
export const Cloud = ({ size = 14, ...p }: P) => (
  <svg {...base(size, 1.8)} {...p}><path d="M7 18a4.5 4.5 0 0 1-.5-9A6 6 0 0 1 18 8.5a4.75 4.75 0 0 1-.5 9.5z" /></svg>
);
export const Cpu = ({ size = 14, ...p }: P) => (
  <svg {...base(size, 1.8)} {...p}><rect x="6" y="6" width="12" height="12" rx="2.5" /><path d="M10 10h4v4h-4zM9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3" /></svg>
);
export const ImageIcon = ({ size = 16, ...p }: P) => (
  <svg {...base(size, 1.8)} {...p}><rect x="3" y="4" width="18" height="16" rx="3" /><circle cx="9" cy="9.5" r="1.7" /><path d="m4 18 5.5-5 4 3.5L17 13l3 3" /></svg>
);
export const ArrowRight = ({ size = 14, ...p }: P) => (
  <svg {...base(size, 1.8)} {...p}><path d="M5 12h14M13 6l6 6-6 6" /></svg>
);
export const Sparkle = ({ size = 14, ...p }: P) => (
  <svg {...base(size, 1.8)} {...p}><path d="M12 3.5 13.8 10l6.7 2-6.7 2L12 20.5 10.2 14l-6.7-2 6.7-2z" /></svg>
);
export const Compare = ({ size = 14, ...p }: P) => (
  <svg {...base(size, 1.8)} {...p}><rect x="3" y="5" width="18" height="14" rx="3" /><path d="M12 3v18" /></svg>
);
export const Columns = ({ size = 14, ...p }: P) => (
  <svg {...base(size, 1.8)} {...p}><rect x="3" y="5" width="8" height="14" rx="2" /><rect x="13" y="5" width="8" height="14" rx="2" /></svg>
);
export const Person = ({ size = 16, ...p }: P) => (
  <svg {...base(size, 1.8)} {...p}><circle cx="12" cy="8" r="4" /><path d="M4.5 20.5c1.2-3.6 4-5.5 7.5-5.5s6.3 1.9 7.5 5.5" /></svg>
);
export const Shirt = ({ size = 16, ...p }: P) => (
  <svg {...base(size, 1.8)} {...p}><path d="M9 3.5 4 6l-1.5 5 3.5 1.2V20.5h12V12.2l3.5-1.2L20 6l-5-2.5c-.6 1.6-1.6 2.5-3 2.5s-2.4-.9-3-2.5Z" /></svg>
);
export const Package = ({ size = 16, ...p }: P) => (
  <svg {...base(size, 1.8)} {...p}><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9Z" /><path d="m4 7.5 8 4.5 8-4.5M12 12v9" /></svg>
);
export const Landscape = ({ size = 16, ...p }: P) => (
  <svg {...base(size, 1.8)} {...p}><path d="m2.5 19 6-9 4 6 2.5-3.5L21.5 19Z" /><circle cx="17" cy="6.5" r="2" /></svg>
);

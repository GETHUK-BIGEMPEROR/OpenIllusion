import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";

/** Tiles keep their media's shape, but only between 9:16 and 16:9: no strip is too tall or too flat. */
export const clampAspect = (a?: number | null) => Math.min(16 / 9, Math.max(9 / 16, a || 4 / 5));

/**
 * Equal-width columns. Each tile takes the leftmost column that is within half a
 * tile of the shortest, so the wall reads left to right like rows, yet columns
 * still even out when heights differ a lot. Heights come from each item's
 * aspect, so nothing jumps while media loads.
 */
export function Masonry<T extends { key: string; aspect?: number | null }>({ items, render, label, minCol = 232, maxCols = 5, gap = 12 }: {
  items: T[]; render: (item: T) => ReactNode; label: string; minCol?: number; maxCols?: number; gap?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const cols = Math.max(2, Math.min(maxCols, Math.floor((width + gap) / (minCol + gap)) || 2));
  const columns = useMemo(() => {
    const colW = Math.max(1, (width - gap * (cols - 1)) / cols);
    const heights = new Array<number>(cols).fill(0);
    const out: T[][] = Array.from({ length: cols }, () => []);
    for (const it of items) {
      const low = Math.min(...heights) + colW / 2;
      const c = heights.findIndex((h) => h <= low);
      out[c].push(it);
      heights[c] += colW / clampAspect(it.aspect) + gap;
    }
    return out;
  }, [items, cols, width, gap]);

  return (
    <div ref={ref} role="list" aria-label={label} className="flex items-start" style={{ gap }}>
      {columns.map((col, i) => (
        <div key={i} className="flex-1 min-w-0 flex flex-col" style={{ gap }}>
          {col.map((it) => <div role="listitem" key={it.key}>{render(it)}</div>)}
        </div>
      ))}
    </div>
  );
}

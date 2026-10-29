import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";

/** Tiles keep their media's shape, but only between 9:16 and 16:9: no strip is too tall or too flat. */
export const clampAspect = (a?: number | null) => Math.min(16 / 9, Math.max(9 / 16, a || 4 / 5));

/**
 * Equal-width columns. Each tile takes the shortest column (the leftmost when they
 * nearly tie), so every tile starts no higher than the one before it: a sorted wall
 * reads in its order, top to bottom and left to right. Heights come from each
 * item's aspect, so nothing jumps while media loads; a tile taller than its media
 * (a caption under it) is measured and the wall makes room.
 *
 * Every tile sits in one parent, placed by position: when a filter or sort moves a
 * tile to another column it slides there, it isn't torn down and rebuilt (its
 * picture decoded again, its loop restarted).
 */
export function Masonry<T extends { key: string; aspect?: number | null }>({ items, render, label, minCol = 232, maxCols = 5 }: {
  items: T[]; render: (item: T) => ReactNode; label: string; minCol?: number; maxCols?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [measured, setMeasured] = useState<Record<string, number>>({});
  const tiles = useRef(new Map<string, HTMLDivElement>());
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Narrow walls (phones) go to two tight columns.
  const small = width > 0 && width < 560;
  const gap = small ? 8 : 14;
  const cols = small ? 2 : Math.max(2, Math.min(maxCols, Math.floor((width + gap) / (minCol + gap)) || 2));
  const colW = Math.max(1, (width - gap * (cols - 1)) / cols);
  const layout = useMemo(() => {
    const heights = new Array<number>(cols).fill(0);
    const at = new Map<string, { x: number; y: number }>();
    for (const it of items) {
      const low = Math.min(...heights) + 1;
      const c = heights.findIndex((h) => h <= low);
      at.set(it.key, { x: c * (colW + gap), y: heights[c] });
      heights[c] += (measured[it.key] ?? colW / clampAspect(it.aspect)) + gap;
    }
    return { at, height: Math.max(0, Math.max(...heights) - gap) };
  }, [items, cols, colW, gap, measured]);

  // A tile whose real height isn't its media's (a caption below) reports it once, and again if it changes.
  useLayoutEffect(() => {
    const ro = new ResizeObserver((entries) => {
      const next: Record<string, number> = {};
      for (const en of entries) {
        const key = (en.target as HTMLElement).dataset.key!;
        next[key] = Math.round(en.contentRect.height);
      }
      setMeasured((m) => (Object.entries(next).some(([k, h]) => Math.abs((m[k] ?? -1) - h) > 1) ? { ...m, ...next } : m));
    });
    for (const el of tiles.current.values()) ro.observe(el);
    return () => ro.disconnect();
  }, [items]);

  return (
    <div ref={ref} role="list" aria-label={label} className="wall" style={{ "--gap": `${gap}px`, height: layout.height } as CSSProperties}>
      {width > 0 && items.map((it) => {
        const p = layout.at.get(it.key)!;
        return (
          <div role="listitem" key={it.key} data-key={it.key} className="tile"
            ref={(el) => { if (el) tiles.current.set(it.key, el); else tiles.current.delete(it.key); }}
            style={{ width: colW, transform: `translate(${p.x}px, ${p.y}px)` }}>
            {render(it)}
          </div>
        );
      })}
    </div>
  );
}

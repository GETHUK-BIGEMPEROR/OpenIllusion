import type { ReactNode } from "react";
import { create } from "zustand";
import type { IconName } from "../components/sprite";

/** What the dialog shows; a function of the optional checkbox so counts follow it. */
export interface ConfirmView {
  title: ReactNode;
  body?: ReactNode;
  /** Thumbnails of what's affected; the first few fan out as a stack. */
  previews?: string[];
  /** How many things it touches, for the "+N" chip under the stack. */
  count?: number;
  /** Small facts under the text, like "214 MB" or "2 still running are kept". */
  facts?: string[];
  action: string;
  /** A second way through, beside the action: "Cover only" next to "Set as cover and reuse its inputs". */
  alt?: string;
  /** Nothing to do: the action button is disabled. */
  empty?: boolean;
}

export interface ConfirmOpts {
  view: (option: boolean) => ConfirmView;
  /** "danger" for deletes; "danger" + hold for what can't be undone. */
  tone?: "danger" | "neutral";
  /** Press and hold the action button to confirm. For permanent deletes. */
  hold?: boolean;
  icon?: IconName;
  option?: { label: (on: boolean) => ReactNode; on?: boolean };
}

export interface ConfirmResult { ok: boolean; option: boolean; /** The second way (``alt``) was picked. */ alt?: boolean }

interface State {
  open: (ConfirmOpts & { resolve: (r: ConfirmResult) => void }) | null;
}

export const useConfirm = create<State>(() => ({ open: null }));

/** Ask before doing something destructive. Resolves when the user decides; Escape and outside clicks cancel. */
export function confirm(opts: ConfirmOpts): Promise<ConfirmResult> {
  return new Promise((resolve) => {
    useConfirm.getState().open?.resolve({ ok: false, option: false });
    useConfirm.setState({ open: { ...opts, resolve } });
  });
}

export function settle(r: ConfirmResult) {
  const cur = useConfirm.getState().open;
  useConfirm.setState({ open: null });
  cur?.resolve(r);
}

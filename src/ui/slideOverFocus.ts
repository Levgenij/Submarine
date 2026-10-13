import { useEffect, useRef } from "react";

// Focus for a slide-over panel that stays mounted while closed, so that it
// can slide out. Closed, its backdrop is inert; open, the app behind it is.
// Opening moves focus into the panel; closing gives it back to the opener,
// unless focus has since moved somewhere else. Put the returned ref on the
// panel, with tabIndex={-1} so it can hold focus without being a Tab stop.
export const useSlideOverFocus = (open: boolean) => {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);

  // Snapshot on the closed-to-open render, before commit. The same commit
  // sets inert, and the browser then moves focus to the body before
  // useEffect, so reading activeElement in the effect would save body.
  if (open && !wasOpenRef.current) {
    const had = document.activeElement;
    const panel = panelRef.current;
    openerRef.current =
      had instanceof HTMLElement && had !== document.body && !(panel && panel.contains(had))
        ? had
        : null;
  }
  wasOpenRef.current = open;

  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (!panel) return;
    if (!panel.contains(document.activeElement)) panel.focus({ preventScroll: true });
    return () => {
      const opener = openerRef.current;
      const now = document.activeElement;
      // Still in the panel, or dropped to the page as the panel went inert.
      if (opener?.isConnected && (!now || now === document.body || panel.contains(now))) {
        opener.focus({ preventScroll: true });
      }
    };
  }, [open]);
  return panelRef;
};

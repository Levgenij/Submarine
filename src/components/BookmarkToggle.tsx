import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { Bookmark } from "lucide-react";

// A directory bookmark has three states. A session bookmark is listed only
// for the server it was made on; a global one in every session's pane of the
// same side.
export type BookmarkState = "none" | "session" | "global";

/** A click moves on: none → this session → global → none. A right-click removes. */
export const NEXT_BOOKMARK_STATE: Record<BookmarkState, BookmarkState> = { none: "session", session: "global", global: "none" };

const STATE_COLOR: Record<BookmarkState, string> = {
  none: "",
  session: "text-amber-400 hover:text-amber-300",
  global: "text-emerald-400 hover:text-emerald-300",
};

const NEXT_STEP: Record<BookmarkState, string> = {
  none: "Click to bookmark it for this session.",
  session: "Click again to make it global.",
  global: "Click to remove the bookmark.",
};

const ARIA_LABEL: Record<BookmarkState, string> = {
  none: "Bookmark: off",
  session: "Bookmark: this session",
  global: "Bookmark: global",
};

const GUIDE_WIDTH = 260;
// Moving the pointer down the Recent / Bookmarks rows should not flash a
// guide over every icon it crosses.
const GUIDE_DELAY = 350;

// The bookmark icon, with a guide (like the Dedicated toggle's) that says
// what the colors mean and what the next click does.
export const BookmarkToggle = ({
  state, onToggle, onRemove, pane, placement = "below", disabled, idleClassName, className = "", size = 11,
}: {
  state: BookmarkState;
  onToggle: () => void;
  /** Right-click: straight to none, without making a session bookmark global on the way. */
  onRemove: () => void;
  /** The pane's name ("Local" / "Remote"): a global bookmark is shared by that side only. */
  pane: string;
  /** "side": next to the icon, so a guide over a dropdown row leaves the rows below readable. */
  placement?: "below" | "side";
  disabled?: boolean;
  /** Color classes while the directory is not bookmarked. */
  idleClassName: string;
  className?: string;
  size?: number;
}) => {
  const descId = useId();
  // The icon's box while its guide shows; null while it is hidden.
  const [guideAt, setGuideAt] = useState<DOMRect | null>(null);
  // The guide's real height, measured before it is painted, to pick a side.
  const [guideH, setGuideH] = useState(0);
  const guideRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<number | null>(null);
  const clearTimer = () => {
    if (timerRef.current !== null) { window.clearTimeout(timerRef.current); timerRef.current = null; }
  };
  const hide = () => { clearTimer(); setGuideAt(null); };
  useEffect(() => clearTimer, []);
  // A disabled button gets no mouseleave.
  useEffect(() => { if (disabled) hide(); }, [disabled]);
  useLayoutEffect(() => {
    const h = guideRef.current?.offsetHeight;
    if (guideAt && h && h !== guideH) setGuideH(h);
  });

  const position = (r: DOMRect): CSSProperties => {
    const maxTop = Math.max(8, window.innerHeight - guideH - 8);
    if (placement === "side") {
      const right = r.right + 8 + GUIDE_WIDTH <= window.innerWidth - 8;
      return {
        left: right ? r.right + 8 : Math.max(8, r.left - GUIDE_WIDTH - 8),
        top: Math.max(8, Math.min(r.top - 10, maxTop)),
      };
    }
    const below = r.bottom + 6 + guideH <= window.innerHeight - 8;
    const above = r.top - 6 - guideH >= 8;
    return {
      left: Math.max(8, Math.min(r.right - GUIDE_WIDTH, window.innerWidth - GUIDE_WIDTH - 8)),
      top: below || !above ? Math.min(r.bottom + 6, maxTop) : r.top - 6 - guideH,
    };
  };

  const legend: Array<{ s: BookmarkState; icon: string; name: string; text: string }> = [
    { s: "none", icon: "text-zinc-500", name: "Off", text: "Not bookmarked." },
    { s: "session", icon: "text-amber-400", name: "Session", text: "Listed only for this server." },
    { s: "global", icon: "text-emerald-400", name: "Global", text: `Listed in the ${pane} pane of every session.` },
  ];

  return (
    <>
      <button
        type="button"
        onClick={onToggle}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (state !== "none") onRemove();
        }}
        disabled={disabled}
        aria-label={ARIA_LABEL[state]}
        aria-describedby={descId}
        // Touch screens fake a hover on tap, so only a real pointer opens it.
        // A held button is a drag passing over, e.g. a bookmark being reordered.
        onMouseEnter={(e) => {
          if (!window.matchMedia("(hover: hover)").matches || e.buttons !== 0) return;
          const el = e.currentTarget;
          clearTimer();
          timerRef.current = window.setTimeout(() => setGuideAt(el.getBoundingClientRect()), GUIDE_DELAY);
        }}
        onMouseLeave={hide}
        onFocus={(e) => { if (e.currentTarget.matches(":focus-visible")) setGuideAt(e.currentTarget.getBoundingClientRect()); }}
        onBlur={hide}
        className={`${className} ${state === "none" ? idleClassName : STATE_COLOR[state]}`}
      >
        <Bookmark size={size} fill={state === "none" ? "none" : "currentColor"} />
      </button>
      {/* What a screen reader announces after the state in the label. */}
      <span id={descId} className="sr-only">
        {`${NEXT_STEP[state]} Clicks go off, this session, global, off. A session bookmark is listed only for this server, a global one in the ${pane} pane of every session.`}
      </span>
      {/* Through a portal: the header and the dropdown clip overflow. Hidden
          until its height is known, so it never paints on the wrong side. */}
      {guideAt && createPortal(
        <div
          ref={guideRef}
          role="tooltip"
          aria-hidden
          style={{ width: GUIDE_WIDTH, ...position(guideAt), visibility: guideH ? "visible" : "hidden" }}
          className="fixed z-[9999] pointer-events-none bg-[#15151a] border border-white/10 rounded-lg shadow-2xl px-3 py-2 text-[11px] leading-snug text-zinc-300 font-sans normal-case tracking-normal"
        >
          <div className="mb-1 text-[10px] font-bold uppercase tracking-wider text-zinc-100">Bookmark</div>
          <p className="text-zinc-400">Keeps a folder one click away in the list under the arrow next to Up.</p>
          <ul className="mt-1.5 flex flex-col gap-0.5">
            {legend.map((l) => (
              <li
                key={l.s}
                className={`flex items-start gap-2 rounded px-1.5 py-1 ${l.s === state ? "bg-white/[0.06] text-zinc-100" : "text-zinc-400"}`}
              >
                <Bookmark size={11} className={`mt-[2px] shrink-0 ${l.icon}`} fill={l.s === "none" ? "none" : "currentColor"} />
                <span><span className="font-semibold">{l.name}</span> - {l.text}</span>
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-[10px] text-zinc-500">Each click moves on: off → session → global → off. Right-click removes it.</p>
          <p className="mt-0.5 text-zinc-100">{NEXT_STEP[state]}</p>
        </div>,
        document.body
      )}
    </>
  );
};

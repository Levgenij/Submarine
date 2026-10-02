import { useState } from "react";

// Inline rename editor for tab context menus (session tabs in DesktopApp,
// terminal tabs in SessionView). Autofocus + select-all, Enter commits,
// Escape cancels. The draft lives here, seeded once from initialValue, so
// each caller decides in onCommit what an empty value means.
export const RenameInput = ({ initialValue, placeholder, onCommit, onCancel }: {
  initialValue: string;
  placeholder?: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) => {
  const [draft, setDraft] = useState(initialValue);
  return (
    <div className="px-2 py-1.5 flex items-center gap-1.5">
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => e.target.select()}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); onCommit(draft); }
          else if (e.key === "Escape") { e.preventDefault(); onCancel(); }
        }}
        placeholder={placeholder ?? "Name…"}
        maxLength={60}
        className="flex-1 min-w-0 bg-black/40 border border-primary/40 rounded px-2 py-1 text-[11px] text-zinc-100 outline-none"
      />
    </div>
  );
};

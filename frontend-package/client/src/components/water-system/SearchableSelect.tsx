import React, { useEffect, useMemo, useRef, useState } from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { Check, ChevronDown } from "lucide-react";

export interface SearchableOption {
  value: string;
  label: string;
  /** Extra text the search should also match (not shown). */
  keywords?: string;
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  options: SearchableOption[];
  placeholder: string;
  /** Shown in the list when there are no options at all. */
  emptyText?: string;
  disabled?: boolean;
  icon?: React.ReactNode;
  testId?: string;
  /** Let the list be wider than the field when the rows are long (pixels). */
  listMinWidth?: number;
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * One field that is both a dropdown and a search box: click to see the whole list,
 * or type to narrow it. Arrow keys move, Enter picks, Escape closes.
 */
export function SearchableSelect({
  value,
  onChange,
  options,
  placeholder,
  emptyText = "Nothing to choose",
  disabled = false,
  icon,
  testId,
  listMinWidth,
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const anchorRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const selected = options.find((o) => o.value === value) ?? null;

  const filtered = useMemo(() => {
    const q = norm(query);
    if (!q) return options;
    const words = q.split(" ");
    const hits = options.filter((o) => {
      const hay = norm(`${o.label} ${o.keywords ?? ""}`);
      return words.every((w) => hay.includes(w));
    });
    // What starts with the typed text comes first: typing "12" puts order 12 above order 312.
    const starts = (o: SearchableOption) => (norm(o.label).startsWith(q) ? 0 : 1);
    return hits.slice().sort((x, y) => starts(x) - starts(y));
  }, [options, query]);

  // Opening: start on the current choice. Typing: start on the first match.
  useEffect(() => {
    if (!open) return;
    const i = query ? 0 : Math.max(0, filtered.findIndex((o) => o.value === value));
    setActive(i);
  }, [open, query]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [open, active, filtered.length]);

  const close = () => {
    setOpen(false);
    setQuery("");
  };

  const pick = (o: SearchableOption) => {
    onChange(o.value);
    close();
    inputRef.current?.blur();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      if (filtered.length === 0) return;
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((i) => (i + step + filtered.length) % filtered.length);
    } else if (e.key === "Enter") {
      if (open && filtered[active]) {
        e.preventDefault();
        pick(filtered[active]);
      }
    } else if (e.key === "Escape") {
      if (open) {
        e.preventDefault();
        close();
      }
    } else if (e.key === "Tab") {
      close();
    }
  };

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={(o) => (o ? setOpen(true) : close())}>
      <PopoverPrimitive.Anchor asChild>
        <div ref={anchorRef} className="relative">
          {icon && (
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 wb-text-cyan">
              {icon}
            </span>
          )}
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded={open}
            aria-autocomplete="list"
            autoComplete="off"
            spellCheck={false}
            disabled={disabled}
            data-testid={testId}
            className={`wb-input h-12 w-full wb-text text-sm outline-none pr-9 ${
              icon ? "pl-9" : "pl-3"
            } disabled:cursor-not-allowed disabled:opacity-50`}
            placeholder={open && selected ? selected.label : placeholder}
            value={open ? query : selected?.label ?? ""}
            onChange={(e) => {
              setQuery(e.target.value);
              if (!open) setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onClick={() => setOpen(true)}
            onKeyDown={onKeyDown}
          />
          <ChevronDown
            className={`pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 opacity-50 transition-transform ${
              open ? "rotate-180" : ""
            }`}
          />
        </div>
      </PopoverPrimitive.Anchor>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="start"
          sideOffset={4}
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
          onInteractOutside={(e) => {
            // A click in the field itself must not close the list.
            if (anchorRef.current?.contains(e.target as Node)) e.preventDefault();
          }}
          className="wb-select-content wb-text z-50 rounded-md p-1 shadow-lg"
          style={{
            width: "var(--radix-popover-trigger-width)",
            minWidth: listMinWidth ? `min(${listMinWidth}px, 92vw)` : undefined,
          }}
        >
          <div
            ref={listRef}
            role="listbox"
            className="max-h-60 overflow-y-auto"
            data-testid={testId ? `${testId}-list` : undefined}
          >
            {filtered.length === 0 ? (
              <div className="px-3 py-2 text-xs wb-text-muted">
                {options.length === 0 ? emptyText : `No match for "${query.trim()}"`}
              </div>
            ) : (
              filtered.map((o, i) => (
                <div
                  key={o.value}
                  role="option"
                  aria-selected={o.value === value}
                  data-index={i}
                  data-active={i === active ? "true" : undefined}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseMove={() => setActive(i)}
                  onClick={() => pick(o)}
                  className="wb-option flex cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm"
                >
                  <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                    {o.value === value && <Check className="h-3.5 w-3.5 wb-text-cyan" />}
                  </span>
                  <span className="truncate">{o.label}</span>
                </div>
              ))
            )}
          </div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

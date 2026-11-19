import { useCallback, useEffect, useMemo, useState } from "react";

/**
 * Tick boxes for the rows of a table. Rows that are no longer shown (filtered out, another
 * date) are dropped from the selection, so "print selected" never prints something unseen.
 */
export function useRowSelection(shownIds: Array<string | number>) {
  const [selected, setSelected] = useState<Set<string | number>>(new Set());
  const key = shownIds.join("|");

  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const shown = new Set(shownIds);
      const next = new Set([...prev].filter((id) => shown.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = useCallback((id: string | number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const allSelected = shownIds.length > 0 && shownIds.every((id) => selected.has(id));

  const toggleAll = useCallback(() => {
    setSelected((prev) => {
      const every = shownIds.length > 0 && shownIds.every((id) => prev.has(id));
      return every ? new Set() : new Set(shownIds);
    });
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  const clear = useCallback(() => setSelected(new Set()), []);

  return useMemo(
    () => ({ selected, toggle, toggleAll, allSelected, clear, count: selected.size }),
    [selected, toggle, toggleAll, allSelected, clear]
  );
}

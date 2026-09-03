import { useEffect } from "react";

/**
 * Close a dialog on Escape.
 *
 * Every dialog has a Cancel or Done button, and none of them handled Escape —
 * which is the other half of "this cannot be exited", since a modal that
 * ignores the key everyone reaches for reads as stuck even when a button is
 * there.
 *
 * Ignored while `busy`: a request is in flight, and dismissing the dialog it
 * belongs to would leave its outcome with nowhere to be reported.
 *
 * Deliberately not a click-outside handler. The dialogs cover most of the
 * screen and several hold a typed confirmation, so a stray click outside
 * discarding one is a worse failure than having to reach for Cancel.
 */
export function useDismiss(onClose: () => void, busy: boolean): void {
  useEffect(() => {
    if (busy) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, busy]);
}

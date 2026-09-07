import { useEffect, useRef } from "react";

export function useDialog(open, onClose) {
  const ref = useRef(null);
  useEffect(() => {
    if (!open || !ref.current) return undefined;
    const previous = document.activeElement;
    const dialog = ref.current;
    const focusable = () => Array.from(dialog.querySelectorAll("button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex='-1'])"));
    focusable()[0]?.focus();
    const keydown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    dialog.addEventListener("keydown", keydown);
    return () => {
      dialog.removeEventListener("keydown", keydown);
      previous?.focus?.();
    };
  }, [open, onClose]);
  return ref;
}

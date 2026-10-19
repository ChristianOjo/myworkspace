import { useEffect, useRef } from 'react';

export function Drawer({ open, title, onClose, children, width = '460px' }: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  width?: string;
}) {
  const panel = useRef<HTMLElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panel.current?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== 'Tab' || !panel.current) return;
      const focusable = Array.from(panel.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )).filter(element => element.getAttribute('aria-hidden') !== 'true');
      if (!focusable.length) {
        event.preventDefault();
        panel.current.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === panel.current)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || active === panel.current)) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      const target = returnFocus.current;
      if (target?.isConnected) window.requestAnimationFrame(() => target.focus());
    };
  }, [open]);

  return <>
    <button type="button" className={`drawer-scrim ${open ? 'is-open' : ''}`} aria-label="Close panel" aria-hidden={!open} tabIndex={open ? 0 : -1} onClick={onClose} />
    <aside ref={panel} className={`drawer ${open ? 'is-open' : ''}`} style={{ maxWidth: width }} role="dialog" aria-modal={open ? 'true' : undefined} aria-label={title} aria-hidden={!open} inert={!open} tabIndex={-1}>
      <button type="button" className="drawer-close icon-button" onClick={onClose} aria-label="Close panel">×</button>
      {children}
    </aside>
  </>;
}

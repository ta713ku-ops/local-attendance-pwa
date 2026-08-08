import { Children, cloneElement, isValidElement, ReactElement, ReactNode, RefObject, useEffect, useRef } from 'react';

let lastDialogTrigger: HTMLElement | null = null;
export function rememberDialogTrigger(element: HTMLElement | null) { lastDialogTrigger = element; }

export function Dialog({ title, children, onClose, closeLabel = '閉じる', actions, initialFocusRef }: { title: string; children: ReactNode; onClose: () => void; closeLabel?: string; actions?: ReactNode; initialFocusRef?: RefObject<HTMLElement | null> }) {
  const panel = useRef<HTMLElement>(null);
  const previous = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => { const active = document.activeElement as HTMLElement | null; previous.current = active && active !== document.body && !panel.current?.contains(active) ? active : lastDialogTrigger; const original = document.body.style.overflow; document.body.style.overflow = 'hidden'; (initialFocusRef?.current ?? panel.current?.querySelector<HTMLElement>('[data-dialog-safe],button,input,select,textarea,[tabindex]:not([tabindex="-1"])'))?.focus(); const key = (event: KeyboardEvent) => { if (event.key === 'Escape') onCloseRef.current(); if (event.key !== 'Tab' || !panel.current) return; const nodes = [...panel.current.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])')]; if (!nodes.length) return; const first = nodes[0], last = nodes[nodes.length - 1]; if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); } }; document.addEventListener('keydown', key); return () => { document.body.style.overflow = original; document.removeEventListener('keydown', key); if (previous.current?.isConnected) previous.current.focus(); }; }, []);
  const safeActions = Children.map(actions, action => { if (!isValidElement(action) || action.type !== 'button') return action; const button = action as ReactElement<{ type?: 'button' | 'submit' | 'reset' }>; return cloneElement(button, { type: button.props.type ?? 'button' }); });
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><section ref={panel} className="dialog-card" role="dialog" aria-modal="true" aria-labelledby="dialog-title"><h2 id="dialog-title">{title}</h2><div className="dialog-body">{children}</div><div className="dialog-actions"><button type="button" data-dialog-safe onClick={onClose}>{closeLabel}</button>{safeActions}</div></section></div>;
}

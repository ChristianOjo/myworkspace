export function Loading({ label = 'Loading' }: { label?: string }) {
  return <div className="loading-state" role="status"><span className="loading-mark" aria-hidden="true" />{label}<span className="sr-only">…</span></div>;
}

export function EmptyState({ title, detail, action }: { title: string; detail?: string; action?: React.ReactNode }) {
  return <div className="empty-state"><span className="empty-index">—</span><h3>{title}</h3>{detail && <p>{detail}</p>}{action}</div>;
}

export function InlineError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return <div className="inline-error" role="alert"><span>{message}</span>{onRetry && <button className="text-button" onClick={onRetry}>Retry</button>}</div>;
}

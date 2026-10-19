export function Brand({ compact = false }: { compact?: boolean }) {
  return <a className={`brand-lockup ${compact ? 'brand-compact' : ''}`} href="/" aria-label="Myworkspace Front Desk">
    <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
    <span><b>MYWORKSPACE</b><small>FRONT DESK</small></span>
  </a>;
}

import type { Level, PlanningCategory } from '@jarvis/core';
import { PLANNING_CATEGORY_LABELS } from '@jarvis/core';
import clsx from 'clsx';
import { Loader2, X } from 'lucide-react';
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

// ---------- Buttons ----------
type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export function Button({
  variant = 'secondary',
  size = 'md',
  className,
  loading,
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
  loading?: boolean;
}) {
  return (
    <button
      className={clsx(
        'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors',
        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-jarvis-400 disabled:opacity-50 disabled:cursor-not-allowed',
        size === 'sm' ? 'text-[13px] px-2.5 py-1.5' : 'text-sm px-3.5 py-2',
        variant === 'primary' && 'bg-jarvis-600 text-white hover:bg-jarvis-700',
        variant === 'secondary' &&
          'bg-surface-raised border border-surface-border text-ink hover:bg-surface-sunken',
        variant === 'ghost' && 'text-ink-muted hover:bg-surface-sunken hover:text-ink',
        variant === 'danger' && 'bg-red-600 text-white hover:bg-red-700',
        className,
      )}
      disabled={disabled || loading}
      {...rest}
    >
      {loading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
      {children}
    </button>
  );
}

// ---------- Surfaces ----------
export function Card({
  className,
  children,
  onClick,
}: {
  className?: string;
  children: ReactNode;
  onClick?: () => void;
}) {
  return (
    <div
      onClick={onClick}
      className={clsx(
        'bg-surface-raised border border-surface-border rounded-xl',
        onClick && 'cursor-pointer hover:border-jarvis-300 transition-colors',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 mb-6">
      <div>
        <h1 className="text-xl font-semibold">{title}</h1>
        {subtitle && <p className="text-sm text-ink-muted mt-1">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-16 px-6">
      {icon && <div className="text-ink-faint mb-3 [&>svg]:h-8 [&>svg]:w-8">{icon}</div>}
      <h3 className="font-medium text-ink">{title}</h3>
      {description && <p className="text-sm text-ink-muted mt-1 max-w-sm">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={clsx('h-5 w-5 animate-spin text-ink-faint', className)} />;
}

export function LoadingPane({ label }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-16 text-ink-muted text-sm">
      <Spinner /> {label ?? 'Loading…'}
    </div>
  );
}

// ---------- Badges & pills ----------
export function Badge({
  children,
  tone = 'neutral',
  className,
}: {
  children: ReactNode;
  tone?: 'neutral' | 'accent' | 'green' | 'amber' | 'red' | 'blue';
  className?: string;
}) {
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium',
        tone === 'neutral' && 'bg-surface-sunken text-ink-muted',
        tone === 'accent' && 'bg-jarvis-100 text-jarvis-800',
        tone === 'green' && 'bg-emerald-100 text-emerald-800',
        tone === 'amber' && 'bg-amber-100 text-amber-800',
        tone === 'red' && 'bg-red-100 text-red-700',
        tone === 'blue' && 'bg-sky-100 text-sky-800',
        className,
      )}
    >
      {children}
    </span>
  );
}

const LEVEL_TONES: Record<Level, 'red' | 'amber' | 'blue' | 'neutral'> = {
  critical: 'red',
  high: 'amber',
  medium: 'blue',
  low: 'neutral',
};

export function LevelPill({
  level,
  label,
}: {
  level: Level;
  /** e.g. "priority" | "urgency" | "effort" */
  label?: string;
}) {
  return (
    <Badge tone={LEVEL_TONES[level]}>
      {level}
      {label ? ` ${label}` : ''}
    </Badge>
  );
}

export function CategoryBadge({ category }: { category: PlanningCategory }) {
  const tones: Record<PlanningCategory, 'red' | 'amber' | 'blue' | 'accent' | 'neutral' | 'green'> =
    {
      do_now: 'red',
      prepare_today: 'amber',
      decide: 'accent',
      waiting_on_others: 'blue',
      follow_up: 'blue',
      read_when_possible: 'green',
      low_priority: 'neutral',
    };
  return <Badge tone={tones[category]}>{PLANNING_CATEGORY_LABELS[category]}</Badge>;
}

// ---------- Forms ----------
export function Input({
  className,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { className?: string }) {
  return (
    <input
      className={clsx(
        'w-full rounded-lg border border-surface-border bg-surface-raised px-3 py-2 text-sm',
        'placeholder:text-ink-faint focus:outline-none focus:ring-2 focus:ring-jarvis-300 focus:border-jarvis-400',
        className,
      )}
      {...rest}
    />
  );
}

export function Textarea({
  className,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { className?: string }) {
  return (
    <textarea
      className={clsx(
        'w-full rounded-lg border border-surface-border bg-surface-raised px-3 py-2 text-sm',
        'placeholder:text-ink-faint focus:outline-none focus:ring-2 focus:ring-jarvis-300 focus:border-jarvis-400',
        className,
      )}
      {...rest}
    />
  );
}

export function Select({
  value,
  onChange,
  options,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  className?: string;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={clsx(
        'rounded-lg border border-surface-border bg-surface-raised px-3 py-2 text-sm',
        'focus:outline-none focus:ring-2 focus:ring-jarvis-300',
        className,
      )}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: string;
  disabled?: boolean;
}) {
  return (
    <label className={clsx('inline-flex items-center gap-2', disabled && 'opacity-50')}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={clsx(
          'relative h-5 w-9 rounded-full transition-colors',
          checked ? 'bg-jarvis-600' : 'bg-surface-border',
        )}
      >
        <span
          className={clsx(
            'absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform',
            checked ? 'translate-x-4.5 left-0' : 'left-0.5',
          )}
          style={{ transform: checked ? 'translateX(18px)' : undefined }}
        />
      </button>
      {label && <span className="text-sm">{label}</span>}
    </label>
  );
}

// ---------- Modal ----------
export function Modal({
  open,
  onClose,
  title,
  children,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  wide?: boolean;
}) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
      onClick={onClose}
    >
      <div
        className={clsx(
          'bg-surface-raised rounded-2xl shadow-xl border border-surface-border w-full max-h-[85vh] overflow-y-auto',
          wide ? 'max-w-2xl' : 'max-w-md',
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-surface-border sticky top-0 bg-surface-raised rounded-t-2xl">
          <h2 className="font-semibold">{title}</h2>
          <button onClick={onClose} className="text-ink-faint hover:text-ink">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="px-5 py-4">{children}</div>
      </div>
    </div>
  );
}

// ---------- Markdown ----------
export function Markdown({ children }: { children: string }) {
  return (
    <div className="prose-jarvis">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  );
}

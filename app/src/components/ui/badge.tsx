import * as React from 'react';

// Simple Badge primitive for status chips
// Usage: <Badge variant="default">Approved</Badge>
export function Badge({
  children,
  variant = 'default',
  className = '',
}: {
  children: React.ReactNode;
  variant?: 'default' | 'success' | 'warning' | 'destructive' | 'muted';
  className?: string;
}) {
  const base = 'inline-flex items-center rounded px-2 py-0.5 text-xs border';
  const styles: Record<string, string> = {
    default: 'bg-gray-900 text-white border-gray-900',
    success: 'bg-emerald-600 text-white border-emerald-600',
    warning: 'bg-amber-600 text-white border-amber-600',
    destructive: 'bg-red-600 text-white border-red-600',
    muted: 'bg-gray-100 text-gray-800 border-gray-200',
  };
  return <span className={`${base} ${styles[variant]} ${className}`}>{children}</span>;
}

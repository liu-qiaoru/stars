import * as React from 'react'
import { cn } from '../../lib/utils'

export function Badge({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border border-[var(--hairline)] bg-[var(--canvas-soft)] px-2.5 py-1 text-xs font-medium text-[var(--ink)]',
        className,
      )}
      {...props}
    />
  )
}

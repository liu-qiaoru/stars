import * as React from 'react'
import { cn } from '../../lib/utils'

export function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      type={type}
      className={cn(
        'flex h-10 w-full rounded-md border border-[var(--hairline)] bg-white px-3 py-2 text-sm text-[var(--ink)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] disabled:opacity-50',
        className,
      )}
      {...props}
    />
  )
}

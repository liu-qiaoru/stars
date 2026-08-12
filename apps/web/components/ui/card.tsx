import * as React from 'react'
import { cn } from '../../lib/utils'

export function Card({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'rounded-xl border border-[var(--hairline)] bg-white shadow-[var(--shadow-2)]',
        className,
      )}
      {...props}
    />
  )
}
export function CardHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('space-y-1.5 p-5', className)} {...props} />
}
export function CardTitle({ className, ...props }: React.ComponentProps<'h2'>) {
  return <h2 className={cn('text-lg font-semibold text-[var(--ink)]', className)} {...props} />
}
export function CardDescription({ className, ...props }: React.ComponentProps<'p'>) {
  return <p className={cn('text-sm leading-6 text-[var(--mute)]', className)} {...props} />
}
export function CardContent({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('p-5 pt-0', className)} {...props} />
}
export function CardFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('flex items-center gap-3 p-5 pt-0', className)} {...props} />
}

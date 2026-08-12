import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../../lib/utils'

const buttonVariants = cva(
  'inline-flex min-h-10 items-center justify-center gap-2 rounded-md px-4 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default: 'bg-[var(--primary)] text-[var(--on-primary)] hover:bg-[var(--primary-hover)]',
        outline:
          'border border-[var(--hairline)] bg-white text-[var(--ink)] hover:bg-[var(--canvas-soft)]',
        ghost: 'text-[var(--ink)] hover:bg-[var(--canvas-soft-2)]',
        destructive: 'bg-[var(--error)] text-white hover:opacity-90',
      },
      size: { default: 'h-10', sm: 'h-9 px-3', icon: 'size-10 p-0' },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
)

export function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<'button'> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Component = asChild ? Slot : 'button'
  return <Component className={cn(buttonVariants({ variant, size }), className)} {...props} />
}

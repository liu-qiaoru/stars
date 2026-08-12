import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** shadcn/ui 的类名合并入口：条件类由 clsx 展开，Tailwind 冲突由 tailwind-merge 消解。 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

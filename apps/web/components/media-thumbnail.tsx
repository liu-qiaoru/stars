import clsx from 'clsx'

export function MediaThumbnail({
  index,
  label,
  className,
}: {
  index: number
  label: string
  className?: string
}) {
  return (
    <div
      aria-label={label}
      className={clsx('media-thumb', className)}
      style={{
        backgroundPosition: `${(index % 3) * 50}% ${Math.floor(index / 3) * 100}%`,
      }}
    />
  )
}

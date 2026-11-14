import { cn } from "../lib/utils"

export function Button({ className, variant = "default", size = "default", ...props }) {
  const variants = {
    default: "btn-glass-primary",
    secondary: "btn-glass-secondary",
    outline: "btn-glass-outline",
    ghost: "btn-glass-ghost",
  }

  const sizes = {
    default: "h-10 px-4 py-2",
    sm: "h-9 rounded-lg px-3",
    lg: "h-11 rounded-xl px-8",
    icon: "h-10 w-10",
  }

  return (
    <button
      className={cn(
        "inline-flex items-center justify-center rounded-xl text-sm font-medium transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-transparent disabled:pointer-events-none disabled:opacity-45",
        variants[variant],
        sizes[size],
        className
      )}
      {...props}
    />
  )
}

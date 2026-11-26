import { cloneElement, isValidElement, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from '../i18n'
import type { Message } from '../i18n/dictionaries'

export type TooltipMessage = Extract<Message, `tip${string}` | `hint3d${string}`>

export function Tooltip({ message, children, info }: {
  message: TooltipMessage
  children: ReactNode
  info?: string
}) {
  const { t } = useTranslation()
  const description = t(message)
  const id = useId()
  const trigger = useRef<HTMLSpanElement>(null)
  const bubble = useRef<HTMLSpanElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [open, setOpen] = useState(false)

  function schedule(next: boolean, delay: number) {
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setOpen(next), delay)
  }

  useEffect(() => () => clearTimeout(timer.current), [])
  useLayoutEffect(() => {
    if (!open) return
    const margin = 8
    const gap = 6
    function place() {
      const element = trigger.current!
      const anchor = element.getBoundingClientRect()
      const popup = bubble.current!
      const { width, height } = popup.getBoundingClientRect()
      const { clientWidth, clientHeight } = document.documentElement
      const below = anchor.bottom + gap
      const above = anchor.top - height - gap
      const top = below + height <= clientHeight - margin || above < margin ? below : above
      popup.style.left = `${Math.max(margin, Math.min(anchor.left, clientWidth - width - margin))}px`
      popup.style.top = `${Math.max(margin, Math.min(top, clientHeight - height - margin))}px`
      popup.style.visibility = !element.getClientRects().length || anchor.bottom < 0 || anchor.top > clientHeight
        ? 'hidden' : 'visible'
    }
    function dismiss(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      clearTimeout(timer.current)
      setOpen(false)
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    window.addEventListener('keydown', dismiss)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('keydown', dismiss)
    }
  }, [open, description])

  const content = !info && isValidElement<{ 'aria-describedby'?: string }>(children) && open
    ? cloneElement(children, { 'aria-describedby': id }) : children
  return <span ref={trigger} className="tooltip-trigger"
    onPointerEnter={event => { if (event.pointerType !== 'touch') schedule(true, 700) }}
    onPointerLeave={() => schedule(false, 120)}
    onFocus={() => schedule(true, 150)}
    onBlur={() => schedule(false, 120)}>
    {content}
    {info && <button className="tooltip-info" type="button" aria-label={t('helpFor').replace('{label}', info)} aria-describedby={open ? id : undefined}
      onPointerEnter={() => schedule(true, 150)} onClick={() => schedule(true, 0)}>?</button>}
    {open && createPortal(<span id={id} ref={bubble} role="tooltip" className="tooltip-popup"
      onPointerEnter={() => clearTimeout(timer.current)} onPointerLeave={() => schedule(false, 120)}>{description}</span>, document.body)}
  </span>
}

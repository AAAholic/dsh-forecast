import React from 'react'
import { createPortal } from 'react-dom'
import { acceptCandidate, tabGesture } from './acceptance.mjs'
import { inputEmpty, sessionEligible } from './controller.mjs'
import { predictionModeKey } from './mode.mjs'

const el = React.createElement

export const GHOST_CSS = `
[data-next-message-ghost-visible] > [data-composer-placeholder]{visibility:hidden!important}
[data-next-message-ghost-visible] > [data-composer-input] p:last-child:after{content:none!important}
[data-next-message-ghost-visible]{min-height:var(--next-message-ghost-height,36px)}
[data-next-message-ghost]{position:absolute;top:4px;left:14px;right:8px;pointer-events:none;white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;line-height:inherit;color:var(--dsw-alias-label-caption);opacity:.62;user-select:none}
[data-next-message-ghost-text]{pointer-events:auto;cursor:pointer;outline:none}
[data-next-message-ghost-text]:hover{opacity:.9}
[data-next-message-tab]{display:inline-block;vertical-align:baseline;font:10px/15px -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;border:1px solid currentColor;border-radius:4px;margin-left:7px;padding:0 4px;opacity:.75}
`

function visible(element) {
  return Boolean(element?.isConnected && element.getClientRects().length
    && getComputedStyle(element).visibility !== 'hidden')
}
function menuVisible(document) {
  return [...document.querySelectorAll('[data-trigger-menu],[role="menu"],[role="listbox"],[role="dialog"],[aria-modal="true"]')].some(visible)
}

/** The resident toolbar owns lifecycle; the ghost lives inside this session's editor. */
export function PredictionGhost(props) {
  const session = props.useSession(value => value)
  const input = props.useInput(value => value)
  const plan = props.useProjection('plan')
  const goal = props.useProjection('goal')
  const model = props.useProjection('modelSelection')
  const modeKey = predictionModeKey({ plan, goal, model })
  const [controller] = React.useState(() => props.createController())
  const snapshot = React.useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const anchor = React.useRef(null), ghost = React.useRef(null), gate = React.useRef(null)
  const [composer, setComposer] = React.useState(null)
  const [composing, setComposing] = React.useState(false)
  const [foreground, setForeground] = React.useState(!document.hidden)
  const [, setDomVersion] = React.useState(0)
  const composition = React.useRef({ active: false, until: 0, timer: null })
  const candidate = snapshot.candidate
  const show = Boolean(foreground && !composing && sessionEligible(session) && inputEmpty(input)
    && candidate?.sessionId === props.sessionId && candidate.generation === controller.generation
    && controller.context?.modeKey === modeKey && controller.enabled && composer?.isContentEditable
    && !composer.hasAttribute('data-composer-composing'))
  gate.current = { candidate, show, sessionId: props.sessionId, controller, composer, shell: props.shell }

  React.useLayoutEffect(() => {
    controller.updateContext({ sessionId: props.sessionId, session, input, modeKey })
  }, [controller, props.sessionId, session, input, modeKey])
  React.useLayoutEffect(() => { controller.connect(); return () => controller.disconnect() }, [controller])

  React.useLayoutEffect(() => {
    const body = anchor.current?.closest('[data-conversation-session]')
    if (!body || body.getAttribute('data-conversation-session') !== props.sessionId) { setComposer(null); return }
    const locate = () => setComposer(body.querySelector('[data-composer-input]'))
    locate()
    const observer = new MutationObserver(records => {
      locate()
      if (records.some(record => record.type === 'attributes')) setDomVersion(value => value + 1)
    })
    observer.observe(body, { childList: true, subtree: true, attributes: true,
      attributeFilter: ['contenteditable', 'data-composer-composing', 'aria-disabled'] })
    return () => observer.disconnect()
  }, [props.sessionId])

  React.useLayoutEffect(() => {
    const parent = composer?.parentElement
    if (!parent) return
    parent.toggleAttribute('data-next-message-ghost-visible', show)
    if (!show || !ghost.current) return () => {
      parent.removeAttribute('data-next-message-ghost-visible')
      parent.style.removeProperty('--next-message-ghost-height')
    }
    const measure = () => parent.style.setProperty('--next-message-ghost-height', `${Math.ceil(ghost.current?.getBoundingClientRect().height ?? 0) + 8}px`)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(ghost.current)
    return () => { observer.disconnect(); parent.removeAttribute('data-next-message-ghost-visible'); parent.style.removeProperty('--next-message-ghost-height') }
  }, [composer, show, candidate?.text])

  React.useEffect(() => {
    const onVisibility = () => { const next = !document.hidden; setForeground(next); controller.setForeground(next) }
    onVisibility()
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [controller])

  const adopt = () => {
    const current = gate.current
    const editor = current.composer
    const body = editor?.closest('[data-conversation-session]')
    if (!current.show || !editor || body?.getAttribute('data-conversation-session') !== current.sessionId) return false
    try {
      const result = acceptCandidate({ controller: current.controller, candidate: current.candidate,
        shell: current.shell(), visible: visible(ghost.current),
        composing: composition.current.active || Date.now() < composition.current.until || editor.hasAttribute('data-composer-composing'),
        menuOpen: menuVisible(editor.ownerDocument), editable: editor.isContentEditable && editor.getAttribute('aria-disabled') !== 'true' })
      if (result) editor.focus({ preventScroll: true })
      return result
    } catch { return false }
  }
  const adoptRef = React.useRef(adopt)
  adoptRef.current = adopt

  React.useEffect(() => {
    const relevant = event => gate.current.composer?.contains(event.target)
    const hideImmediately = () => {
      if (ghost.current) ghost.current.style.visibility = 'hidden'
      gate.current.composer?.parentElement?.removeAttribute('data-next-message-ghost-visible')
    }
    const onStart = event => {
      if (!relevant(event)) return
      clearTimeout(composition.current.timer)
      composition.current.active = true; setComposing(true); hideImmediately()
    }
    const onEnd = event => {
      if (!relevant(event)) return
      composition.current.active = false; composition.current.until = Date.now() + 10
      clearTimeout(composition.current.timer)
      composition.current.timer = setTimeout(() => setComposing(false), 10)
    }
    const onBeforeInput = event => { if (relevant(event) && event.inputType?.startsWith('insert')) hideImmediately() }
    const onKeyDown = event => {
      const editor = gate.current.composer
      if (!tabGesture(event) || !editor || !relevant(event)
        || !(editor === document.activeElement || editor.contains(document.activeElement))) return
      if (adoptRef.current()) { event.preventDefault(); event.stopPropagation() }
    }
    document.addEventListener('compositionstart', onStart, true)
    document.addEventListener('compositionend', onEnd, true)
    document.addEventListener('beforeinput', onBeforeInput, true)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      clearTimeout(composition.current.timer)
      document.removeEventListener('compositionstart', onStart, true)
      document.removeEventListener('compositionend', onEnd, true)
      document.removeEventListener('beforeinput', onBeforeInput, true)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [])

  return el(React.Fragment, null,
    el('span', { ref: anchor, 'data-next-message-anchor': '', style: { display: 'none' } }),
    show && composer?.parentElement ? createPortal(el('div', { ref: ghost, 'data-next-message-ghost': '', 'aria-live': 'polite' },
      el('span', { role: 'button', tabIndex: -1, 'data-next-message-ghost-text': '',
        'aria-label': `预测下一句：${candidate.text}。点击或 Tab 填入，可继续编辑。`,
        title: 'Tab 填入，可继续编辑',
        onPointerDown: event => { if (event.button === 0) event.preventDefault() },
        onClick: event => { event.preventDefault(); adoptRef.current() },
        onKeyDown: event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation() } },
      }, candidate.text),
      el('kbd', { 'data-next-message-tab': '', 'aria-hidden': true }, 'Tab')),
    composer.parentElement) : null)
}

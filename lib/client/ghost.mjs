import React from 'react'
import { createPortal } from 'react-dom'
import { acceptCandidate, adoptionUnchanged, retractCandidate, tabGesture } from './acceptance.mjs'
import { inputEmpty, sessionEligible } from './controller.mjs'
import { predictionModeKey } from './mode.mjs'
import { trackGhostLayout } from './ghost-layout.mjs'

const el = React.createElement

export const GHOST_CSS = `
[data-next-message-ghost-visible] > [data-composer-placeholder]{visibility:hidden!important}
[data-next-message-ghost-visible] > [data-composer-input] p:last-child:after{content:none!important}
[data-next-message-ghost-visible] > [data-composer-input]:focus-visible{outline:none!important}
[data-next-message-ghost-visible]{min-height:var(--next-message-ghost-height,0px)!important}
[data-next-message-ghost]{position:absolute;box-sizing:border-box;margin:0;padding:0;border:0;pointer-events:none;visibility:hidden;color:var(--dsw-alias-label-caption);opacity:.62;user-select:none}
[data-next-message-ghost-measured]{visibility:visible}
[data-next-message-ghost-text]{pointer-events:none;outline:none}
[data-next-message-tab]{display:inline-block;vertical-align:baseline;font:10px/15px -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;border:1px solid currentColor;border-radius:4px;margin-left:7px;padding:0 4px;opacity:.75;text-indent:0;text-align:start;white-space:nowrap;direction:ltr}
[data-next-message-separate-hint] > [data-next-message-tab]{display:block;width:max-content;margin-left:0}
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
  const adoption = React.useRef(null)
  const candidate = snapshot.candidate
  const show = Boolean(foreground && !composing && sessionEligible(session) && inputEmpty(input)
    && candidate?.sessionId === props.sessionId && candidate.generation === controller.generation
    && controller.context?.modeKey === modeKey && controller.enabled && composer?.isContentEditable
    && !composer.hasAttribute('data-composer-composing'))
  gate.current = { candidate, show, sessionId: props.sessionId, controller, composer, shell: props.shell }

  React.useLayoutEffect(() => {
    controller.updateContext({ sessionId: props.sessionId, session, input, modeKey })
    if (adoption.current && !adoptionUnchanged({ controller, adoption: adoption.current, input })) adoption.current = null
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
    const stop = show && ghost.current ? trackGhostLayout(composer, ghost.current) : null
    return () => { stop?.(); parent.removeAttribute('data-next-message-ghost-visible') }
  }, [composer, show, candidate?.text])

  React.useEffect(() => {
    const parent = composer?.parentElement
    if (!parent) return
    // A long ghost can extend below the empty editor. Clicking that empty area
    // focuses the editor as well; no pointer gesture ever adopts a prediction.
    const focusEmptyArea = event => {
      if (gate.current.show && event.target === parent) composer.focus({ preventScroll: true })
    }
    parent.addEventListener('click', focusEmptyArea)
    return () => parent.removeEventListener('click', focusEmptyArea)
  }, [composer])

  React.useEffect(() => {
    const onVisibility = () => { const next = !document.hidden; setForeground(next); controller.setForeground(next) }
    onVisibility()
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [controller])

  const toggleAdoption = () => {
    const current = gate.current
    const editor = current.composer
    const body = editor?.closest('[data-conversation-session]')
    if (!editor || body?.getAttribute('data-conversation-session') !== current.sessionId) return false
    try {
      const shell = current.shell()
      const guards = { controller: current.controller, shell,
        composing: composition.current.active || Date.now() < composition.current.until || editor.hasAttribute('data-composer-composing'),
        menuOpen: menuVisible(editor.ownerDocument), editable: foreground && editor.isContentEditable && editor.getAttribute('aria-disabled') !== 'true' }
      const receipt = adoption.current
      if (receipt) {
        if (receipt.composer !== editor || !adoptionUnchanged({ ...guards, adoption: receipt, input: shell.snapshot })) adoption.current = null
        else {
          const removed = retractCandidate({ ...guards, adoption: receipt, visible: visible(editor) })
          if (removed) { adoption.current = null; editor.focus({ preventScroll: true }) }
          return removed
        }
      }
      if (!current.show) return false
      const inserted = acceptCandidate({ ...guards, candidate: current.candidate, visible: visible(ghost.current) })
      if (inserted) {
        adoption.current = { candidate: current.candidate, draftRev: shell.snapshot.draftRev, composer: editor }
        editor.focus({ preventScroll: true })
      }
      return inserted
    } catch { return false }
  }
  const adoptRef = React.useRef(toggleAdoption)
  adoptRef.current = toggleAdoption

  React.useEffect(() => {
    const relevant = event => gate.current.composer?.contains(event.target)
    const hideImmediately = () => {
      if (ghost.current) ghost.current.style.visibility = 'hidden'
      gate.current.composer?.parentElement?.removeAttribute('data-next-message-ghost-visible')
    }
    const onStart = event => {
      if (!relevant(event)) return
      adoption.current = null
      clearTimeout(composition.current.timer)
      composition.current.active = true; setComposing(true); hideImmediately()
    }
    const onEnd = event => {
      if (!relevant(event)) return
      composition.current.active = false; composition.current.until = Date.now() + 10
      clearTimeout(composition.current.timer)
      composition.current.timer = setTimeout(() => setComposing(false), 10)
    }
    const onBeforeInput = event => {
      if (!relevant(event)) return
      adoption.current = null
      if (event.inputType?.startsWith('insert')) hideImmediately()
    }
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
      el('span', { 'data-next-message-ghost-text': '',
        'aria-label': `预测下一句：${candidate.text}。Tab 采纳，未编辑时再次 Tab 撤回。`,
      }, candidate.text),
      el('kbd', { 'data-next-message-tab': '', 'aria-hidden': true }, 'Tab')),
    composer.parentElement) : null)
}

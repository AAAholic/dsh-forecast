import React, { useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { PredictionGhost, GHOST_CSS } from '__FORECAST_GHOST__'
import { PredictionController } from '__FORECAST_CONTROLLER__'

// Only the host-facing stores and insertion facade are faked. Rendering,
// lifecycle, controller, adoption, retraction, and all ghost CSS are production.
const source = initial => {
  let value = initial
  const listeners = new Set()
  return {
    getSnapshot: () => value,
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) },
    set: next => { value = next; for (const listener of listeners) listener() },
  }
}
const hook = store => selector => selector(useSyncExternalStore(store.subscribe, store.getSnapshot))
const session = source({ sessionId: 'fixture', openState: 'open', running: false, blank: false })
const input = source({ draft: '', phase: 'plain', attachmentIds: [], occurrences: [], draftRev: 0 })
const settings = source({ status: 'ready', value: { enabled: true } })
const editor = document.querySelector('[data-composer-input]')
const editorParagraph = editor.firstElementChild
const params = new URL(location.href).searchParams
let text = params.get('text') || '好的，我来把这个问题整理成一份可以直接提交的 issue。'
const remoteCalls = []
const controller = new PredictionController({ settingsScope: settings, autoConnect: false,
  fetcher: async (url, options) => {
    remoteCalls.push({ url, body: options?.body })
    return { ok: true, json: async () => ({
      sessionId: 'fixture', enabled: true, status: 'ready', key: 'fixture-key',
      token: 'fixture-token', suggestion: text,
    }) }
  },
})
const renderDraft = draft => {
  if (draft) editorParagraph.textContent = draft
  else editorParagraph.replaceChildren(document.createElement('br'))
}
const setDraft = (draft, fields = {}) => {
  renderDraft(draft)
  input.set({ ...input.getSnapshot(), draft, draftRev: input.getSnapshot().draftRev + 1, ...fields })
}
const shell = {
  get snapshot() { return input.getSnapshot() },
  actions: {
    captureInsertion: () => ({ start: 0, end: 0, draftRev: input.getSnapshot().draftRev }),
    insertText(value, span) {
      const previous = input.getSnapshot()
      if (span.draftRev !== previous.draftRev) return false
      setDraft(previous.draft.slice(0, span.start) + value + previous.draft.slice(span.end))
      return true
    },
  },
}
editor.addEventListener('input', () => {
  input.set({ ...input.getSnapshot(), draft: editor.innerText.replace(/\n$/, ''), draftRev: input.getSnapshot().draftRev + 1 })
})
const style = document.createElement('style')
style.textContent = GHOST_CSS
document.head.append(style)
const root = createRoot(document.querySelector('#toolbar'))
const component = React.createElement(PredictionGhost, {
  sessionId: 'fixture', useSession: hook(session), useInput: hook(input),
  useProjection: () => null, createController: () => controller, shell: () => shell,
})
root.render(params.has('strict') ? React.createElement(React.StrictMode, null, component) : component)
window.fixture = {
  input, session, controller, setDraft, remoteCalls,
  configure({ skin, variant, width, parentStyle, inputStyle, paragraphStyle, ancestorStyle, parentHeight } = {}) {
    if (skin !== undefined) {
      document.body.classList.toggle('skin', skin)
      document.body.toggleAttribute('data-dsh-claude-style', skin)
      document.body.toggleAttribute('data-dsh-claude-composer-active', skin)
    }
    if (variant) {
      document.querySelector('[data-composer-card]').dataset.composerVariant = variant
      document.querySelector('#frame').dataset.phase = variant === 'hero' ? 'hero' : 'active'
    }
    if (width) document.querySelector('#frame').style.width = width + 'px'
    if (parentStyle) Object.assign(editor.parentElement.style, parentStyle)
    if (inputStyle) Object.assign(editor.style, inputStyle)
    if (paragraphStyle) Object.assign(editorParagraph.style, paragraphStyle)
    if (ancestorStyle) Object.assign(document.querySelector('#frame').style, ancestorStyle)
    if (parentHeight) editor.parentElement.style.setProperty('--next-message-ghost-height', parentHeight.value, parentHeight.priority || '')
  },
  candidate(next) {
    text = next
    controller.publish({ ...controller.state, candidate: { ...controller.state.candidate, text } })
  },
  dispose() { root.unmount(); controller.dispose(); style.remove() },
}

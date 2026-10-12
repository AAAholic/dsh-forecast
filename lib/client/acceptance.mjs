import { inputEmpty } from './controller.mjs'

export function canAccept({ candidate, current, input, visible, composing, menuOpen, editable }) {
  return Boolean(candidate && current && inputEmpty(input) && visible && !composing && !menuOpen && editable)
}

/** Borrow the retained session facade; never call setDraft or submit. */
export function acceptCandidate({ controller, candidate, shell, visible, composing, menuOpen, editable }) {
  if (!shell?.actions || !canAccept({ candidate, current: controller.candidateCurrent(candidate),
    input: shell.snapshot, visible, composing, menuOpen, editable })) return false
  const before = shell.snapshot
  const span = shell.actions.captureInsertion()
  if (!inputEmpty(shell.snapshot) || span.draftRev !== before.draftRev
    || span.start !== 0 || span.end !== 0 || !controller.candidateCurrent(candidate)) return false
  const inserted = shell.actions.insertText(candidate.text, span)
  if (inserted !== true || shell.snapshot.draft !== candidate.text) return false
  controller.accepted(candidate)
  return true
}

export function tabGesture(event) {
  return event.key === 'Tab' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey
    && !event.defaultPrevented && !event.isComposing && event.keyCode !== 229 && !event.repeat
}

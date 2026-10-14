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

/** A retraction receipt is valid only for the exact, untouched adopted revision. */
export function adoptionUnchanged({ controller, adoption, input }) {
  return Boolean(adoption?.candidate && controller.candidateCurrent(adoption.candidate)
    && Number.isSafeInteger(adoption.draftRev) && input?.draftRev === adoption.draftRev
    && input.draft === adoption.candidate.text && input.phase === 'plain'
    && Array.isArray(input.attachmentIds) && input.attachmentIds.length === 0
    && (input.occurrences?.length ?? 0) === 0)
}

/** Delete only our own unedited insertion, using the Host's revision-checked range API. */
export function retractCandidate({ controller, adoption, shell, visible, composing, menuOpen, editable }) {
  if (!shell?.actions || !visible || composing || menuOpen || !editable
    || !adoptionUnchanged({ controller, adoption, input: shell.snapshot })) return false
  const removed = shell.actions.insertText('', { start: 0,
    end: adoption.candidate.text.length, draftRev: adoption.draftRev })
  return removed === true && inputEmpty(shell.snapshot)
}

export function tabGesture(event) {
  return event.key === 'Tab' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey
    && !event.defaultPrevented && !event.isComposing && event.keyCode !== 229 && !event.repeat
}

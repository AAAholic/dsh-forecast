// Measure the editable surface, never the toolbar/card's inherited typography.
const typography = ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontStretch',
  'lineHeight', 'letterSpacing', 'wordSpacing', 'textIndent', 'textAlign',
  'textTransform', 'direction', 'writingMode', 'tabSize', 'wordBreak', 'overflowWrap', 'whiteSpace']
const number = value => Number.parseFloat(value) || 0
const set = (style, key, value) => { if (style[key] !== value) style[key] = value }

export function trackGhostLayout(editor, ghost) {
  const parent = editor.parentElement, win = editor.ownerDocument.defaultView
  const spacer = editor.ownerDocument.createElement('div')
  spacer.setAttribute('data-next-message-ghost-spacer', '')
  spacer.setAttribute('aria-hidden', 'true')
  spacer.style.cssText = 'pointer-events:none;visibility:hidden;flex:none;width:0;padding:0;border:0;margin:0;'
  parent.append(spacer)
  const position = parent.style.getPropertyValue('position')
  const priority = parent.style.getPropertyPriority('position')
  const positioned = win.getComputedStyle(parent).position === 'static'
  if (positioned) parent.style.setProperty('position', 'relative')
  let frame
  const measure = () => {
    if (!editor.isConnected || !ghost.isConnected) return
    const e = editor.getBoundingClientRect(), p = parent.getBoundingClientRect()
    // Rects include ancestor scaling; CSS offsets do not.
    const sx = parent.offsetWidth ? p.width / parent.offsetWidth : 1
    const sy = parent.offsetHeight ? p.height / parent.offsetHeight : 1
    const style = win.getComputedStyle(editor)
    const block = editor.firstElementChild
    const textStyle = win.getComputedStyle(block || editor)
    const b = block?.getBoundingClientRect()
    const insetX = number(textStyle.borderLeftWidth) + number(textStyle.paddingLeft)
    const insetY = number(textStyle.borderTopWidth) + number(textStyle.paddingTop)
    const left = b ? (b.left - p.left) / sx - parent.clientLeft + parent.scrollLeft + insetX
      : (e.left - p.left) / sx - parent.clientLeft + parent.scrollLeft + number(style.borderLeftWidth) + number(style.paddingLeft)
    const top = b ? (b.top - p.top) / sy - parent.clientTop + parent.scrollTop + insetY
      : (e.top - p.top) / sy - parent.clientTop + parent.scrollTop + number(style.borderTopWidth) + number(style.paddingTop)
    const width = b ? b.width / sx - insetX - number(textStyle.borderRightWidth) - number(textStyle.paddingRight) : editor.clientWidth - number(style.paddingLeft) - number(style.paddingRight)
    for (const key of typography) set(ghost.style, key, textStyle[key])
    set(ghost.style, 'left', `${left}px`)
    set(ghost.style, 'top', `${top}px`)
    set(ghost.style, 'width', `${Math.max(0, width)}px`)
    const bottomInset = number(style.paddingBottom) + number(style.borderBottomWidth)
    // Add only the missing flow height; skin min-height rules cannot override it.
    const extra = Math.max(0, top + ghost.getBoundingClientRect().height / sy + bottomInset
      - ((e.bottom - p.top) / sy - parent.clientTop + parent.scrollTop))
    set(spacer.style, 'height', `${Math.ceil(extra)}px`)
    frame = win.requestAnimationFrame(measure)
  }
  // Track computed styles as well as geometry (including CSS-only skin switches).
  measure()
  return () => {
    win.cancelAnimationFrame(frame)
    spacer.remove()
    if (positioned) {
      if (position) parent.style.setProperty('position', position, priority)
      else parent.style.removeProperty('position')
    }
  }
}

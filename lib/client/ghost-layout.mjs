// The editor's first paragraph is the layout authority. Never insert measuring
// characters into the Lexical-owned DOM: that can change selection and drafts.
const TEXT_PROPERTIES = [
  'font-family', 'font-size', 'font-weight', 'font-style', 'font-stretch',
  'font-variant', 'font-kerning', 'font-feature-settings', 'font-variation-settings',
  'font-optical-sizing', 'line-height', 'letter-spacing', 'word-spacing',
  'text-align', 'text-indent', 'text-transform', 'text-rendering',
  'white-space', 'word-break', 'overflow-wrap', 'tab-size', 'direction',
]
const px = value => Number.parseFloat(value) || 0
function setStyle(element, property, value) {
  if (element.style.getPropertyValue(property) !== value) element.style.setProperty(property, value)
}
function borderBoxSize(style, dimension, start, end) {
  return px(style[dimension]) + (style.boxSizing === 'border-box' ? 0
    : px(style[`padding${start}`]) + px(style[`padding${end}`])
      + px(style[`border${start}Width`]) + px(style[`border${end}Width`]))
}

/** Keep the overlay in the same local CSS coordinate system as its text. */
export function trackGhostLayout(composer, ghost) {
  const parent = composer.parentElement
  const document = composer.ownerDocument
  const window = document.defaultView
  const previousHeight = parent.style.getPropertyValue('--next-message-ghost-height')
  const previousPriority = parent.style.getPropertyPriority('--next-message-ghost-height')
  let frame = 0, stopped = false, paragraph = null
  const schedule = () => {
    if (!stopped && !frame) frame = window.requestAnimationFrame(() => { frame = 0; measure() })
  }
  const resize = new window.ResizeObserver(schedule)
  const measure = () => {
    if (!composer.isConnected || !ghost.isConnected || !composer.getClientRects().length) return
    const next = composer.firstElementChild?.tagName === 'P' ? composer.firstElementChild : composer
    if (next !== paragraph) {
      if (paragraph && paragraph !== composer) resize.unobserve(paragraph)
      paragraph = next
      resize.observe(paragraph)
    }
    const sourceStyle = window.getComputedStyle(paragraph)
    const editorStyle = window.getComputedStyle(composer)
    const parentStyle = window.getComputedStyle(parent)
    const containingBlock = ghost.offsetParent
    if (!containingBlock) return
    const blockStyle = window.getComputedStyle(containingBlock)
    const blockRect = containingBlock.getBoundingClientRect()
    // Both viewport rectangles include ancestor zoom/scale. CSS offsets do not.
    const scaleX = blockRect.width / borderBoxSize(blockStyle, 'width', 'Left', 'Right')
    const scaleY = blockRect.height / borderBoxSize(blockStyle, 'height', 'Top', 'Bottom')
    if (![scaleX, scaleY].every(value => Number.isFinite(value) && value > 0)) return
    const textRect = paragraph.getBoundingClientRect()
    const textLeft = textRect.left + (px(sourceStyle.borderLeftWidth) + px(sourceStyle.paddingLeft)) * scaleX
    const textTop = textRect.top + (px(sourceStyle.borderTopWidth) + px(sourceStyle.paddingTop)) * scaleY
    const width = textRect.width / scaleX - px(sourceStyle.borderLeftWidth) - px(sourceStyle.borderRightWidth)
      - px(sourceStyle.paddingLeft) - px(sourceStyle.paddingRight)
    // Absolute positioning starts at the containing block's padding edge.
    // Its padding is already in textRect; subtracting it again shifts the ghost.
    setStyle(ghost, 'left', `${(textLeft - blockRect.left) / scaleX - px(blockStyle.borderLeftWidth) + containingBlock.scrollLeft}px`)
    setStyle(ghost, 'top', `${(textTop - blockRect.top) / scaleY - px(blockStyle.borderTopWidth) + containingBlock.scrollTop}px`)
    setStyle(ghost, 'width', `${Math.max(0, width)}px`)
    for (const property of TEXT_PROPERTIES) setStyle(ghost, property, sourceStyle.getPropertyValue(property))
    // A trailing inline control shifts centered/right-aligned text. Keep the
    // hint on its own line in those layouts so it cannot move the candidate.
    const separateHint = sourceStyle.direction === 'rtl'
      || ['center', 'right', 'end', 'justify'].includes(sourceStyle.textAlign)
    ghost.toggleAttribute('data-next-message-separate-hint', separateHint)
    const ghostRect = ghost.getBoundingClientRect()
    const parentRect = parent.getBoundingClientRect()
    let bottom = (ghostRect.bottom - parentRect.top) / scaleY + parent.scrollTop
      + px(sourceStyle.paddingBottom) + px(sourceStyle.borderBottomWidth)
    if (paragraph !== composer) bottom += px(sourceStyle.marginBottom) + px(editorStyle.paddingBottom) + px(editorStyle.borderBottomWidth)
    bottom += px(editorStyle.marginBottom) + px(parentStyle.paddingBottom) + px(parentStyle.borderBottomWidth)
    if (parentStyle.boxSizing !== 'border-box') bottom -= px(parentStyle.paddingTop) + px(parentStyle.paddingBottom)
      + px(parentStyle.borderTopWidth) + px(parentStyle.borderBottomWidth)
    setStyle(parent, '--next-message-ghost-height', `${Math.max(0, Math.ceil(bottom))}px`)
    ghost.setAttribute('data-next-message-ghost-measured', '')
  }
  resize.observe(composer)
  resize.observe(parent)
  resize.observe(ghost)
  // Theme changes may leave the empty editor's dimensions unchanged while
  // changing its font, padding or position. ResizeObserver alone misses those.
  const mutations = new window.MutationObserver(records => {
    if (records.some(record => record.target !== ghost && !ghost.contains(record.target))) schedule()
  })
  mutations.observe(composer, { attributes: true, childList: true, subtree: true, characterData: true })
  for (let ancestor = parent; ancestor; ancestor = ancestor.parentElement) mutations.observe(ancestor, { attributes: true })
  if (document.head) mutations.observe(document.head, { attributes: true, childList: true, subtree: true, characterData: true })
  document.addEventListener('load', schedule, true)
  document.addEventListener('scroll', schedule, true)
  document.fonts?.addEventListener('loadingdone', schedule)
  window.addEventListener('resize', schedule)
  window.visualViewport?.addEventListener('resize', schedule)
  measure()
  return () => {
    stopped = true
    window.cancelAnimationFrame(frame)
    resize.disconnect()
    mutations.disconnect()
    document.removeEventListener('load', schedule, true)
    document.removeEventListener('scroll', schedule, true)
    document.fonts?.removeEventListener('loadingdone', schedule)
    window.removeEventListener('resize', schedule)
    window.visualViewport?.removeEventListener('resize', schedule)
    ghost.removeAttribute('data-next-message-ghost-measured')
    if (previousHeight) parent.style.setProperty('--next-message-ghost-height', previousHeight, previousPriority)
    else parent.style.removeProperty('--next-message-ghost-height')
  }
}

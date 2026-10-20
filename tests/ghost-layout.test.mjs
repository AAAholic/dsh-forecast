import { test } from 'node:test'
import assert from 'node:assert/strict'
import { trackGhostLayout } from '../lib/client/ghost-layout.mjs'

for (const [name, padding, font] of [['native',14,'16px'], ['inline',0,'14px'], ['hero',12,'15px']]) {
  test(`ghost geometry and lifecycle: ${name}`, () => {
    let tick, cancelled = false, removed = false
    const style = { position:'relative', fontSize:font, lineHeight:'24px', whiteSpace:'pre-wrap', paddingLeft:`${padding}px`, paddingRight:'8px', paddingTop:'4px', paddingBottom:'0px' }
    const spacer = { setAttribute(){}, style:{}, remove(){removed=true} }
    const win = { getComputedStyle: () => style, requestAnimationFrame: fn => {tick=fn;return 42}, cancelAnimationFrame: id => {cancelled=id===42} }
    const parent = { style:{getPropertyValue:()=>'',getPropertyPriority:()=>''}, append(){}, clientLeft:2, clientTop:3, scrollLeft:0, scrollTop:0, offsetWidth:300, offsetHeight:40,
      getBoundingClientRect:()=>({left:100,top:100,width:300,height:40}) }
    const editor = { parentElement:parent, ownerDocument:{defaultView:win,createElement:()=>spacer}, isConnected:true, clientWidth:280,
      getBoundingClientRect:()=>({left:102,top:103,bottom:143}) }
    const ghost = {isConnected:true,style:{},getBoundingClientRect:()=>({height:96})}
    const stop = trackGhostLayout(editor,ghost)
    assert.equal(ghost.style.left,`${padding}px`)
    assert.equal(ghost.style.top,'4px')
    assert.equal(ghost.style.width,`${280-padding-8}px`)
    assert.equal(ghost.style.fontSize,font)
    assert.equal(spacer.style.height,'60px')
    // A stylesheet-only skin switch updates typography and wrapping without a resize event.
    style.paddingLeft='0px';style.fontSize='14px';tick()
    assert.equal(ghost.style.left,'0px');assert.equal(ghost.style.fontSize,'14px')
    stop();assert.ok(cancelled);assert.ok(removed)
  })
}

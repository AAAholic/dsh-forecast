import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
const source = readFileSync(new URL('../../lib/client/ghost-layout.mjs', import.meta.url), 'utf8').replace('export function', 'window.trackGhostLayout = function')
const text = '先检查现有实现，再给我一个可以直接执行的方案。长候选应完整显示并遵循真实输入区的换行宽度。\n第二段内容 abcdefghijklmnopqrstuvwxyz0123456789'
for (const skin of ['native', 'inline', 'hero']) {
  test(`${skin}: anchor, typography, wrapping, height, live switch and cleanup`, async ({ page }) => {
    await page.setContent(`<style>
      #scroll{width:280px;max-height:200px;overflow:auto} #grow{position:relative;font:16px/24px sans-serif}
      #editor{padding:4px 8px 0 14px;white-space:pre-wrap;overflow-wrap:anywhere;outline:0} p{margin:0}
      #ghost{position:absolute;pointer-events:none;box-sizing:content-box;margin:0;padding:0;border:0}
      .inline #scroll{padding:7px 36px 7px 14px;border:1px solid} .inline #grow{font-size:15px;min-height:24px!important}
      .inline #editor{padding:0;font-size:14px;line-height:24px}
      .hero #editor{padding:8px 12px;font-size:15px;line-height:26px}
      </style><div id="scroll"><div id="grow"><div id="editor" contenteditable="true"><p><br></p></div><div id="ghost"></div></div></div>`)
    await page.evaluate(({ source, text, skin }) => {
      document.body.className = skin
      window.eval(source)
      ghost.textContent = text
      window.stopLayout = window.trackGhostLayout(editor, ghost)
    }, { source, text, skin })
    const verify = async () => {
      await page.waitForTimeout(60)
      const metrics = await page.evaluate(text => {
        const p = editor.firstElementChild, r = p.getBoundingClientRect(), g = ghost.getBoundingClientRect()
        // Independent reference with actual editor markup and candidate text.
        p.textContent = text
        const range = document.createRange(); range.selectNodeContents(p)
        const textHeight = p.getBoundingClientRect().height
        p.innerHTML = '<br>'
        return { dx:g.left-r.left, dy:g.top-r.top, width:g.width-r.width,
          font:getComputedStyle(ghost).font, editorFont:getComputedStyle(p).font,
          textHeight, height:g.height, bottom:g.bottom, parentBottom:grow.getBoundingClientRect().bottom }
      }, text)
      expect(Math.abs(metrics.dx)).toBeLessThan(0.6)
      expect(Math.abs(metrics.dy)).toBeLessThan(0.6)
      expect(Math.abs(metrics.width)).toBeLessThan(0.6)
      expect(metrics.font).toBe(metrics.editorFont)
      expect(Math.abs(metrics.height-metrics.textHeight)).toBeLessThan(0.6)
      expect(metrics.parentBottom).toBeGreaterThanOrEqual(metrics.bottom-0.6)
    }
    await verify()
    await page.evaluate(() => { document.getElementById('scroll').style.width='170px'; document.body.className='inline'; grow.style.transform='scale(.9)'; grow.style.transformOrigin='top left' })
    await verify()
    await page.evaluate(() => window.stopLayout())
    await expect(page.locator('[data-next-message-ghost-spacer]')).toHaveCount(0)
  })
}

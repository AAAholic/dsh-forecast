// Real Chromium/React regression for issue #2. No browser profile or network
// account is used. Existing Playwright may be selected with DSH_PLAYWRIGHT_MODULES.
// --baseline records failures without failing; --source-root permits an immutable
// before snapshot. Pass --output <directory> to keep metrics and screenshots.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import { createRequire } from 'node:module'

const root = path.resolve(import.meta.dirname, '..')
const arg = name => {
  const at = process.argv.indexOf(name)
  return at < 0 ? undefined : process.argv[at + 1]
}
const sourceRoot = path.resolve(arg('--source-root') || root)
const output = path.resolve(arg('--output') || fs.mkdtempSync(path.join(os.tmpdir(), 'forecast-browser-')))
const baseline = process.argv.includes('--baseline')
const require = createRequire(import.meta.url)
function dependency(name) {
  try { return require(name) } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error
    if (name === 'playwright' && process.env.DSH_PLAYWRIGHT_MODULES) {
      return createRequire(path.join(path.resolve(process.env.DSH_PLAYWRIGHT_MODULES), 'package.json'))(name)
    }
    throw new Error(`Missing existing ${name}; install development dependencies or set DSH_PLAYWRIGHT_MODULES`)
  }
}
const { chromium } = dependency('playwright')
const { build } = dependency('esbuild')
const nodePaths = [path.join(root, 'node_modules')]
const result = await build({
  entryPoints: [path.join(root, 'tests/fixtures/ghost-browser.mjs')],
  alias: {
    __FORECAST_GHOST__: path.join(sourceRoot, 'lib/client/ghost.mjs'),
    __FORECAST_CONTROLLER__: path.join(sourceRoot, 'lib/client/controller.mjs'),
  },
  nodePaths, bundle: true, write: false, format: 'iife', platform: 'browser',
  target: 'es2022', define: { 'process.env.NODE_ENV': '"development"' }, logLevel: 'silent',
})
const css = fs.readFileSync(path.join(root, 'tests/fixtures/ghost-browser.css'), 'utf8')
const html = `<!doctype html><html><head><meta charset="utf-8"><title>Forecast issue 2 regression</title>
<style>${css}</style></head><body><section id="frame" data-conversation-session="fixture">
<div data-composer-seat><div data-composer-card data-composer-variant="inline">
<div class="RlGAzG_scroll" data-input-scroll><div class="RlGAzG_grow" data-dsh-claude-part="input-grow">
<div class="RlGAzG_input" data-composer-input contenteditable="true" role="textbox"><p><br></p></div>
<div class="RlGAzG_placeholder" data-composer-placeholder>给助手发送消息…</div>
</div></div><div id="toolbar"></div></div></div></section><button id="next">Next focus target</button>
<script src="/fixture.js"></script></body></html>`
const server = http.createServer((request, response) => {
  if (request.url === '/fixture.js') {
    response.setHeader('Content-Type', 'text/javascript')
    response.end(result.outputFiles[0].text)
  } else {
    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    response.end(html)
  }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const browser = await chromium.launch({
  headless: true,
  ...(process.env.DSH_CHROME_PATH ? { executablePath: process.env.DSH_CHROME_PATH } : {}),
  args: ['--no-sandbox'],
})
const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } })
const errors = [], checks = [], cases = []
page.on('pageerror', error => errors.push(error.message))
await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort())
const url = `http://127.0.0.1:${server.address().port}/`
const check = (name, passed, details) => checks.push({ name, passed: Boolean(passed), ...(details === undefined ? {} : { details }) })
const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
const ghost = '[data-next-message-ghost-text]'
const input = '[data-composer-input]'
async function load(config, text, strict = false) {
  const params = new URLSearchParams()
  if (text) params.set('text', text)
  if (strict) params.set('strict', '')
  await page.goto(url + '?' + params)
  await page.waitForSelector(ghost)
  await page.evaluate(config => window.fixture.configure(config), config)
  await settle()
}
async function measure(selector) {
  return page.locator(selector).evaluate(element => {
    const rect = node => {
      const value = node.getBoundingClientRect()
      return { x: value.x, y: value.y, width: value.width, height: value.height, bottom: value.bottom, right: value.right }
    }
    const characters = []
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      const node = walker.currentNode
      for (let index = 0; index < node.length; index++) {
        const range = document.createRange()
        range.setStart(node, index); range.setEnd(node, index + 1)
        const value = range.getBoundingClientRect()
        characters.push({ char: node.data[index], x: value.x, y: value.y, width: value.width, height: value.height })
      }
    }
    const css = getComputedStyle(element)
    const grow = document.querySelector('[data-composer-input]').parentElement
    const scroll = document.querySelector('[data-input-scroll]')
    const badge = document.querySelector('[data-next-message-tab]')
    return {
      rect: rect(element), grow: rect(grow), scroll: rect(scroll),
      scrollHeight: scroll.scrollHeight, scrollClientHeight: scroll.clientHeight,
      growHeight: grow.clientHeight, growScrollHeight: grow.scrollHeight,
      font: Object.fromEntries(['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing', 'wordSpacing', 'textIndent', 'whiteSpace', 'wordBreak', 'overflowWrap'].map(key => [key, css[key]])),
      characters, lines: new Set(characters.filter(char => char.width).map(char => char.y)).size,
      badge: badge ? rect(badge) : null,
      parentMinHeight: grow.style.minHeight,
      parentMinPriority: grow.style.getPropertyPriority('min-height'),
    }
  })
}
async function compareAdoption(name) {
  const preview = await measure(ghost)
  await page.locator(input).focus()
  await page.keyboard.press('Tab')
  await page.waitForFunction(() => window.fixture.input.getSnapshot().draft !== '')
  const adopted = await measure(`${input} > p`)
  const deltas = preview.characters.map((char, index) => {
    const actual = adopted.characters[index]
    return actual ? { dx: char.x - actual.x, dy: char.y - actual.y, dw: char.width - actual.width } : { dx: Infinity, dy: Infinity, dw: Infinity }
  })
  const max = key => Math.max(0, ...deltas.map(delta => Math.abs(delta[key])))
  const metrics = { name, preview, adopted, firstDelta: deltas[0], maxDelta: { x: max('dx'), y: max('dy'), width: max('dw') } }
  cases.push(metrics)
  check(`${name}: text origins match actual adoption`, max('dx') <= 0.8 && max('dy') <= 0.8, metrics.maxDelta)
  check(`${name}: identical glyph advances and line wrapping`, max('dw') <= 0.8 && preview.lines === adopted.lines, { previewLines: preview.lines, adoptedLines: adopted.lines, glyphDelta: max('dw') })
  check(`${name}: font metrics match actual input paragraph`, JSON.stringify(preview.font) === JSON.stringify(adopted.font), { preview: preview.font, adopted: adopted.font })
  const lastBottom = Math.max(...preview.characters.map(char => char.y + char.height), preview.badge?.bottom || 0)
  check(`${name}: grow contains all preview lines and Tab hint`, lastBottom <= preview.grow.bottom + 0.8, { lastBottom, growBottom: preview.grow.bottom, scrollHeight: preview.scrollHeight })
  check(`${name}: Tab adopts complete candidate`, await page.evaluate(() => window.fixture.input.getSnapshot().draft === window.fixture.controller.state.candidate.text))
  await page.keyboard.press('Tab')
  await page.waitForSelector(ghost)
  check(`${name}: second Tab retracts untouched draft`, await page.evaluate(() => window.fixture.input.getSnapshot().draft === ''))
  await settle()
  await page.screenshot({ path: path.join(output, name + '.png') })
  return metrics
}
try {
  fs.mkdirSync(output, { recursive: true })
  const long = '这是一条较长的下一句候选建议，用来观察多行时它是否仍然与空输入框的光标起点对齐，并且不会被输入框的下边裁掉。Mixed English words and 中文标点，保持换行一致。'
  for (const [name, config, text] of [
    ['default-short', { skin: false, width: 560 }],
    ['default-multiline', { skin: false, width: 360 }, long],
    ['claude-inline-short', { skin: true, variant: 'inline', width: 560 }],
    ['claude-inline-multiline', { skin: true, variant: 'inline', width: 360 }, long],
    ['claude-inline-narrow', { skin: true, variant: 'inline', width: 240 }, long],
    ['claude-card-hero', { skin: true, variant: 'hero', width: 560 }, long],
    ['parent-border-padding', { skin: true, variant: 'inline', width: 400,
      parentStyle: { border: '3px solid transparent', padding: '11px 13px 17px 19px' } }, long],
    ['input-border-padding', { skin: true, variant: 'inline', width: 400,
      inputStyle: { border: '2px solid transparent', padding: '5px 9px 7px 11px' } }, long],
    ['paragraph-typography', { skin: true, variant: 'inline', width: 400,
      paragraphStyle: { fontFamily: 'monospace', fontWeight: '600', fontSize: '17px', lineHeight: '29px', letterSpacing: '0.4px', wordSpacing: '1px', textIndent: '9px' } }, long],
    ['paragraph-margin-padding', { skin: true, variant: 'inline', width: 400,
      paragraphStyle: { margin: '5px 7px 9px 11px', padding: '3px 5px 7px 9px', border: '2px solid transparent' } }, long],
    ['center-aligned-short', { skin: true, variant: 'inline', width: 400,
      paragraphStyle: { textAlign: 'center' } }, '检查结果。'],
    ['right-aligned-short', { skin: true, variant: 'inline', width: 400,
      paragraphStyle: { textAlign: 'right' } }, '检查结果。'],
    ['rtl-mixed-short', { skin: true, variant: 'inline', width: 400,
      paragraphStyle: { direction: 'rtl' } }, 'نتيجة report 中文 123.'],
    ['url-and-explicit-newlines', { skin: true, variant: 'inline', width: 320 },
      '检查 https://example.org/long-path-with-a-very-long-unbroken-segment/abcdefghijklmno1234567890\n再核对中文第二行。\n最后输出结果。'],
  ]) { await load(config, text); await compareAdoption(name) }

  await load({ skin: false, width: 560 }, long)
  await page.evaluate(() => window.fixture.configure({ skin: true }))
  await settle()
  await compareAdoption('dynamic-skin-on')
  await page.evaluate(() => window.fixture.configure({ width: 290 }))
  await settle()
  await compareAdoption('dynamic-resize')
  await page.evaluate(() => window.fixture.configure({ skin: false }))
  await settle()
  await compareAdoption('dynamic-skin-off')

  await load({ skin: true, variant: 'inline', width: 360 }, long)
  await page.evaluate(() => window.fixture.configure({ ancestorStyle: { transform: 'scale(1.25)', transformOrigin: 'top left' } }))
  await settle()
  await compareAdoption('dynamic-scale-125')
  await page.evaluate(() => window.fixture.configure({ ancestorStyle: { transform: 'scale(0.8)' } }))
  await settle()
  await compareAdoption('dynamic-scale-080')
  await page.evaluate(() => window.fixture.configure({ ancestorStyle: { transform: 'scale(1.25, 0.8)' } }))
  await settle()
  await compareAdoption('dynamic-nonuniform-scale')
  await page.evaluate(() => window.fixture.configure({ ancestorStyle: { transform: 'none', zoom: '1.25' } }))
  await settle()
  await compareAdoption('dynamic-zoom-125')
  await page.evaluate(() => window.fixture.configure({ ancestorStyle: { zoom: '0.8', fontFamily: 'monospace', fontWeight: '600', lineHeight: '2' } }))
  await settle()
  await compareAdoption('dynamic-zoom-080-ancestor-style')

  await load({ skin: true, variant: 'inline', width: 360 }, long, true)
  await compareAdoption('react-strict-mode')
  await settle()
  const churn = await page.evaluate(() => new Promise(resolve => {
    let changes = 0
    const parent = document.querySelector('[data-composer-input]').parentElement
    const observer = new MutationObserver(records => { changes += records.filter(record => record.type === 'attributes').length })
    observer.observe(parent, { attributes: true, subtree: true })
    setTimeout(() => { observer.disconnect(); resolve(changes) }, 150)
  }))
  check('settled layout produces no continuing style mutation loop', churn === 0, { mutationsOver150ms: churn })

  await load({ skin: true, width: 400 })
  await page.locator(input).focus()
  await page.keyboard.press('Tab')
  await page.waitForFunction(() => window.fixture.input.getSnapshot().draft !== '')
  await page.keyboard.press('End')
  await page.keyboard.type('edited')
  const edited = await page.evaluate(() => window.fixture.input.getSnapshot().draft)
  await page.keyboard.press('Tab')
  check('editing adopted draft prevents retraction', await page.evaluate(value => window.fixture.input.getSnapshot().draft === value, edited))
  check('typing does not submit any draft', await page.evaluate(() => !window.fixture.remoteCalls.some(call => /submit/.test(call.url))))

  await load({ skin: true, width: 400 })
  await page.locator(input).focus()
  await page.locator(input).evaluate(element => element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '你' })))
  await page.keyboard.press('Tab')
  check('IME composition prevents adoption', await page.evaluate(() => window.fixture.input.getSnapshot().draft === ''))
  check('IME composition hides preview', await page.locator(ghost).count() === 0)

  await load({ skin: true, width: 400 })
  await page.evaluate(() => { const menu = document.createElement('div'); menu.setAttribute('role', 'listbox'); menu.textContent = 'Suggestion menu'; document.body.append(menu) })
  await page.locator(input).focus()
  await page.keyboard.press('Tab')
  check('visible menu prevents adoption', await page.evaluate(() => window.fixture.input.getSnapshot().draft === ''))

  await load({ skin: true, width: 400 })
  await page.locator(input).focus()
  await page.keyboard.press('Shift+Tab')
  check('Shift+Tab retains normal focus navigation', await page.evaluate(() => window.fixture.input.getSnapshot().draft === ''))

  await load({ skin: true, width: 400, parentStyle: { minHeight: '53px' } })
  await page.evaluate(() => window.fixture.dispose())
  check('unmount removes ghost and restores prior inline min-height', await page.evaluate(() => !document.querySelector('[data-next-message-ghost]') && document.querySelector('[data-composer-input]').parentElement.style.minHeight === '53px'))
  check('unmount removes visibility marker and temporary custom property', await page.evaluate(() => {
    const parent = document.querySelector('[data-composer-input]').parentElement
    return !parent.hasAttribute('data-next-message-ghost-visible') && !parent.style.getPropertyValue('--next-message-ghost-height')
  }))
  await load({ skin: true, width: 400 })
  await page.evaluate(() => window.fixture.setDraft('owned by user'))
  await settle()
  await page.evaluate(() => window.fixture.configure({ parentHeight: { value: '71px', priority: 'important' } }))
  await page.evaluate(() => window.fixture.setDraft(''))
  await page.waitForSelector(ghost)
  await settle()
  await page.evaluate(() => window.fixture.dispose())
  check('unmount restores existing custom property value and priority', await page.evaluate(() => {
    const parent = document.querySelector('[data-composer-input]').parentElement
    return parent.style.getPropertyValue('--next-message-ghost-height') === '71px' && parent.style.getPropertyPriority('--next-message-ghost-height') === 'important'
  }))
  check('no browser runtime exceptions', errors.length === 0, errors)
} catch (error) {
  check('browser suite completed', false, error.stack)
} finally {
  await browser.close()
  await new Promise(resolve => server.close(resolve))
}
const report = { baseline, sourceRoot, checks, cases, errors, passed: checks.filter(check => check.passed).length, failed: checks.filter(check => !check.passed).length }
fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
for (const check of checks) console.log(`${check.passed ? 'PASS' : 'FAIL'} ${check.name}${check.passed || !check.details ? '' : ' ' + JSON.stringify(check.details)}`)
console.log(`${report.passed}/${checks.length} browser checks passed; evidence: ${output}`)
if (report.failed && !baseline) process.exitCode = 1

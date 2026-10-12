import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { buildSync } from 'esbuild'

const built = buildSync({ entryPoints: [fileURLToPath(new URL('../lib/client/toggle.mjs', import.meta.url))],
  bundle: true, write: false, format: 'cjs', platform: 'node', external: ['react'] })
const react = { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }) }
const module = { exports: {} }
vm.runInNewContext(built.outputFiles[0].text, { module, exports: module.exports,
  require(name) { assert.equal(name, 'react'); return react } })
const { ForecastToggle, registerForecastToggle } = module.exports

test('the one forecast switch registers on the composer toolbar, with no settings card', () => {
  const registrations = [], cleanup = [], snapshot = { status: 'ready', writable: true, value: { enabled: true } }
  const ctx = {
    configForms: {
      get(namespace) { assert.equal(namespace, 'dsh-forecast'); return { getSnapshot: () => snapshot, subscribe: () => () => cleanup.push('form') } },
      whileServed(namespaces, fn) { assert.equal(namespaces.join(','), 'dsh-forecast'); return fn() },
    },
    locale: { register: () => () => cleanup.push('locale') },
    slots: {
      inject(name, fn) { assert.equal(name, 'conversation.input.left'); return fn() },
      register(options, component) { registrations.push({ options, component }); return () => cleanup.push('slot') },
    },
  }
  const off = registerForecastToggle(ctx)
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].options.name, 'conversation.input.left')
  assert.equal(registrations[0].component, ForecastToggle)
  off()
  assert.deepEqual(cleanup, ['slot', 'locale', 'form'])
})

test('toolbar click immediately toggles persisted enabled and preserves composer focus', () => {
  const calls = [], state = { available: true, writable: true, enabled: true, saving: false, failed: false }
  const props = { useForecastToggle: selector => selector(state), t: key => key, toggle: value => calls.push(value) }
  const tree = ForecastToggle(props), button = tree.children[0]
  assert.equal(button.props.role, 'switch')
  assert.equal(button.props['aria-checked'], true)
  let focusPreserved = false
  button.props.onMouseDown({ preventDefault() { focusPreserved = true } })
  button.props.onClick()
  assert.equal(focusPreserved, true)
  assert.deepEqual(calls, [false])
  state.saving = true
  const saving = ForecastToggle(props).children[0]
  assert.equal(saving.props.disabled, true)
  saving.props.onClick()
  assert.deepEqual(calls, [false])
  state.saving = false; state.writable = false
  ForecastToggle(props).children[0].props.onClick()
  assert.deepEqual(calls, [false])
})

test('a failed switch reports feedback beside the same single control', () => {
  const tree = ForecastToggle({ useForecastToggle: selector => selector({ available: true, writable: true,
    enabled: false, saving: false, failed: true }), t: key => key, toggle() {} })
  assert.equal(tree.children[0].props['aria-checked'], false)
  assert.equal(tree.children[1].props.role, 'status')
  assert.equal(tree.children[1].children[0], 'failed')
})

test('the state label is inside the capsule and distinguishes forecast from closed', () => {
  for (const [enabled, text] of [[true, '预报'], [false, '关闭']]) {
    const tree = ForecastToggle({ useForecastToggle: selector => selector({ available: true, writable: true,
      enabled, saving: false, failed: false }), t: key => ({ onDisplay: '预报', offDisplay: '关闭' })[key] ?? key, toggle() {} })
    const button = tree.children[0]
    assert.equal(button.children.length, 1)
    const track = button.children[0]
    assert.ok(Object.hasOwn(track.props, 'data-forecast-toggle-track'))
    assert.ok(Object.hasOwn(track.children[0].props, 'data-forecast-toggle-label'))
    assert.equal(track.children[0].children[0], text)
    assert.ok(Object.hasOwn(track.children[1].props, 'data-forecast-toggle-thumb'))
  }
})

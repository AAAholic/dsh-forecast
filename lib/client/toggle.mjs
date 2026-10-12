import React from 'react'
import { SwitchSettingsForm } from './settings-model.mjs'

const NS = 'ui.dsh-forecast'
const locales = {
  zh: { label: '预报', onDisplay: '预报', offDisplay: '关闭', on: '提示词预报，已开启', off: '提示词预报，已关闭',
    saving: '切换中…', failed: '未能切换，请重试。', readOnly: '当前部署只读，无法修改。' },
  en: { label: 'Forecast', onDisplay: 'On', offDisplay: 'Off', on: 'Prompt forecast is on', off: 'Prompt forecast is off',
    saving: 'Switching…', failed: 'The change failed. Please try again.', readOnly: 'This deployment is read-only.' },
}

export const TOGGLE_CSS = `
[data-forecast-toggle-wrap]{display:inline-flex;align-items:center;gap:5px;flex:none;min-width:0}
[data-forecast-toggle]{display:inline-flex;align-items:center;min-height:28px;padding:2px 0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:12px/20px -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;white-space:nowrap;cursor:pointer}
[data-forecast-toggle]:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
[data-forecast-toggle]:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
[data-forecast-toggle]:disabled{opacity:.45;cursor:default}
[data-forecast-toggle-track]{position:relative;display:inline-block;box-sizing:border-box;width:58px;height:22px;flex:none;border-radius:999px;border:1px solid #c8d3df;background:#edf1f6;transition:background .16s,border-color .16s}
[data-forecast-toggle][aria-checked="true"] [data-forecast-toggle-track]{background:#dcebf8;border-color:#bad2e5}
[data-forecast-toggle-label]{position:absolute;top:0;right:5px;font-size:11px;line-height:20px;letter-spacing:.1px;color:#65707b;pointer-events:none;user-select:none}
[data-forecast-toggle][aria-checked="true"] [data-forecast-toggle-label]{left:5px;right:auto;color:#496981}
[data-forecast-toggle-thumb]{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#a6afb9;transition:left .16s,background .16s}
[data-forecast-toggle][aria-checked="true"] [data-forecast-toggle-thumb]{left:38px;background:#79a9ce}
[data-forecast-toggle-status]{font:11px/16px -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;color:var(--dsw-alias-label-error)}
@media(prefers-reduced-motion:reduce){[data-forecast-toggle-track],[data-forecast-toggle-thumb]{transition:none}}
`

const el = React.createElement
export function ForecastToggle(props) {
  const state = props.useForecastToggle(value => value)
  if (!state.available) return null
  const disabled = !state.writable || state.saving
  const status = !state.writable ? 'readOnly' : state.saving ? 'saving' : state.failed ? 'failed' : null
  const label = props.t(state.enabled ? 'on' : 'off')
  return el('span', { 'data-forecast-toggle-wrap': '' },
    el('button', { type: 'button', role: 'switch', 'data-forecast-toggle': '',
      'aria-label': label, 'aria-checked': state.enabled, 'aria-busy': state.saving,
      title: status ? props.t(status) : label, disabled,
      onMouseDown: event => event.preventDefault(),
      onClick: () => { if (!disabled) void props.toggle(!state.enabled) },
    }, el('span', { 'data-forecast-toggle-track': '', 'aria-hidden': true },
      el('span', { 'data-forecast-toggle-label': '' }, props.t(state.enabled ? 'onDisplay' : 'offDisplay')),
      el('span', { 'data-forecast-toggle-thumb': '' }))),
    state.failed ? el('span', { role: 'status', 'data-forecast-toggle-status': '' }, props.t('failed')) : null)
}

/** One persisted switch, directly beside the composer's left toolbar controls. */
export function registerForecastToggle(ctx, namespace = 'dsh-forecast') {
  const form = new SwitchSettingsForm(ctx.configForms.get(namespace))
  const offLocale = ctx.locale.register(NS, locales)
  const offSlot = ctx.configForms.whileServed([namespace], () => ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left', id: `${namespace}-toggle`, locale: NS,
    inject: () => ({ hooks: { forecastToggle: { getSnapshot: form.getSnapshot, subscribe: form.subscribe } }, toggle: form.toggle }),
  }, ForecastToggle)))
  return () => { offSlot(); offLocale(); form.dispose() }
}

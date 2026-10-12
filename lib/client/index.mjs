import { PredictionController } from './controller.mjs'
import { PredictionGhost, GHOST_CSS } from './ghost.mjs'
import { registerForecastToggle, TOGGLE_CSS } from './toggle.mjs'

export const name = 'dsh-forecast'
export const inject = ['slots', 'locale', 'configForms', 'sessions', 'conversation']

export function apply(ctx) {
  const scope = ctx.configForms.get(name)
  const offToggle = registerForecastToggle(ctx, name)
  const style = document.createElement('style')
  style.dataset.nextMessageStyle = ''
  style.textContent = `${GHOST_CSS}\n${TOGGLE_CSS}`
  document.head.appendChild(style)
  const offSlot = ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left', id: name,
    inject: sessionId => ({
      createController: () => new PredictionController({ settingsScope: scope, autoConnect: false }),
      shell: () => ctx.conversation.input.for(ctx.sessions.scope(sessionId)),
    }),
  }, PredictionGhost))
  return () => { offSlot(); offToggle(); style.remove() }
}

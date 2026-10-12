function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  }
  return value
}

/** Semantic projection values only: a goal can change objective without changing phase. */
export function predictionModeKey({ plan, goal, model } = {}) {
  return JSON.stringify(canonical({ plan: plan ?? null, goal: goal ?? null, model: model?.next ?? null }))
}

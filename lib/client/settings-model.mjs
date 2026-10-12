export class SwitchSettingsForm {
  constructor(scope) {
    this.scope = scope
    this.saving = false
    this.failed = false
    this.listeners = new Set()
    this.cache = null
    this.off = scope.subscribe(() => this.emit())
  }
  subscribe = listener => { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  emit() { for (const listener of this.listeners) listener() }
  getSnapshot = () => {
    const snapshot = this.scope.getSnapshot()
    if (this.cache?.snapshot === snapshot && this.cache.saving === this.saving && this.cache.failed === this.failed) return this.cache.value
    const value = Object.freeze({ available: snapshot.status !== 'unavailable',
      writable: snapshot.status === 'ready' && snapshot.writable === true,
      enabled: snapshot.value?.enabled !== false, saving: this.saving, failed: this.failed })
    this.cache = { snapshot, saving: this.saving, failed: this.failed, value }
    return value
  }
  toggle = async enabled => {
    if (this.saving || !this.getSnapshot().writable) return
    this.saving = true; this.failed = false; this.emit()
    try {
      const accepted = await this.scope.set('enabled', enabled)
      this.failed = accepted === false || this.scope.getSnapshot().value?.enabled !== enabled
    } catch { this.failed = true }
    finally { this.saving = false; this.emit() }
  }
  dispose() { this.off(); this.listeners.clear() }
}

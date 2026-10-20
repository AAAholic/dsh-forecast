window.__ModuleLoader__.load({id:"dsh-forecast",factory:(require)=>{var module={exports:{}};var exports=module.exports;
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name2 in all)
    __defProp(target, name2, { get: all[name2], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// lib/client/index.mjs
var index_exports = {};
__export(index_exports, {
  apply: () => apply,
  inject: () => inject,
  name: () => name
});
module.exports = __toCommonJS(index_exports);

// lib/client/controller.mjs
var API = "/api/dsh-forecast";
var requestId = () => globalThis.crypto?.randomUUID?.() ?? `next-${Date.now()}-${Math.random().toString(36).slice(2)}`;
function sessionEligible(session) {
  return Boolean(session && typeof session.sessionId === "string" && session.sessionId && session.openState === "open" && session.running !== true && session.blank !== true && session.removed !== true && session.subagent == null && (session.pendingSubmissions?.length ?? 0) === 0);
}
function inputEmpty(input) {
  return Boolean(input && input.draft === "" && input.phase === "plain" && Array.isArray(input.attachmentIds) && input.attachmentIds.length === 0 && (input.occurrences?.length ?? 0) === 0);
}
function contextSignature(context) {
  const session = context?.session;
  return JSON.stringify([
    context?.sessionId,
    context?.modeKey,
    sessionEligible(session),
    session?.openState,
    session?.running,
    session?.removed,
    session?.blank,
    session?.subagent != null,
    (session?.pendingSubmissions?.length ?? 0) > 0
  ]);
}
var PredictionController = class {
  constructor({
    settingsScope,
    fetcher = (...args) => globalThis.fetch(...args),
    schedule = (...args) => globalThis.setTimeout(...args),
    clear = (...args) => globalThis.clearTimeout(...args),
    autoConnect = true
  } = {}) {
    this.settingsScope = settingsScope;
    this.fetcher = fetcher;
    this.schedule = schedule;
    this.clear = clear;
    this.listeners = /* @__PURE__ */ new Set();
    this.seen = /* @__PURE__ */ new Set();
    this.acceptedTokens = /* @__PURE__ */ new Set();
    this.suppressedKeys = /* @__PURE__ */ new Set();
    this.generation = 0;
    this.context = null;
    this.signature = "";
    this.foreground = true;
    this.disposed = false;
    this.suspended = true;
    this.enabled = false;
    this.abort = new AbortController();
    this.timer = null;
    this.flight = null;
    this.prediction = null;
    this.settleReads = 0;
    this.state = Object.freeze({ key: null, status: "idle", candidate: null });
    this.offSettings = null;
    if (autoConnect) this.connect();
  }
  getSnapshot = () => this.state;
  subscribe = (listener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  emit() {
    for (const listener of this.listeners) listener();
  }
  publish(next) {
    this.state = Object.freeze(next);
    this.emit();
  }
  connect() {
    if (this.disposed || !this.suspended) return;
    this.suspended = false;
    this.offSettings = this.settingsScope?.subscribe(() => this.syncSettings());
    this.syncSettings();
    void this.read();
  }
  disconnect() {
    this.suspended = true;
    this.invalidate();
    this.offSettings?.();
    this.offSettings = null;
  }
  syncSettings() {
    if (this.disposed) return;
    const snapshot = this.settingsScope?.getSnapshot();
    const enabled = snapshot?.status === "ready" && snapshot.value?.enabled !== false;
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    this.invalidate();
    if (enabled) void this.read();
  }
  updateContext(context) {
    if (this.disposed) return;
    const signature = contextSignature(context);
    if (this.context?.sessionId === context?.sessionId && this.context?.modeKey !== context?.modeKey) {
      const key = this.state.key ?? this.prediction?.key;
      if (key) this.suppressedKeys.add(`${context.sessionId}\0${key}`);
    }
    this.context = context;
    if (signature === this.signature) return;
    this.signature = signature;
    this.invalidate();
    void this.read();
  }
  setForeground(foreground) {
    if (this.disposed || this.foreground === foreground) return;
    this.foreground = foreground;
    if (!foreground) {
      this.clear(this.timer);
      this.timer = null;
    } else void this.read();
    this.emit();
  }
  current(generation) {
    return !this.disposed && !this.suspended && this.enabled && generation === this.generation && this.context?.sessionId === this.context?.session?.sessionId && sessionEligible(this.context?.session);
  }
  async remote(path, body, signal) {
    const response = await this.fetcher(`${API}/${path}`, body === void 0 ? { credentials: "same-origin", cache: "no-store", signal } : {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }
  invalidate() {
    this.generation += 1;
    this.clear(this.timer);
    this.timer = null;
    this.abort.abort();
    this.abort = new AbortController();
    this.flight = null;
    const prediction = this.prediction;
    this.prediction = null;
    this.settleReads = 0;
    if (prediction) void this.remote("cancel", prediction).catch(() => {
    });
    this.publish({ key: null, status: "idle", candidate: null });
  }
  async read() {
    const generation = this.generation;
    if (!this.foreground || !this.current(generation) || this.flight) return this.flight;
    this.clear(this.timer);
    this.timer = null;
    const sessionId = this.context.sessionId;
    const signal = this.abort.signal;
    const operation = Promise.resolve().then(async () => {
      try {
        const payload = await this.remote(`state?sessionId=${encodeURIComponent(sessionId)}`, void 0, signal);
        if (this.current(generation)) await this.receive(payload, generation);
      } catch {
        if (this.current(generation)) this.publish({ key: this.state.key, status: "failed", candidate: null });
      } finally {
        if (generation === this.generation) this.flight = null;
      }
    });
    this.flight = operation;
    return operation;
  }
  async receive(payload, generation) {
    if (!this.current(generation) || payload?.sessionId !== this.context.sessionId || payload.enabled !== true) return;
    const key = typeof payload.key === "string" && payload.key ? payload.key : null;
    if (key && this.suppressedKeys.has(`${payload.sessionId}\0${key}`)) {
      this.publish({ key, status: "empty", candidate: null });
      return;
    }
    if (payload.status === "ready" && key && typeof payload.token === "string" && payload.token && typeof payload.suggestion === "string" && payload.suggestion.trim()) {
      this.publish({ key, status: "ready", candidate: Object.freeze({
        sessionId: payload.sessionId,
        key,
        token: payload.token,
        text: payload.suggestion.trim(),
        generation
      }) });
      return;
    }
    this.publish({ key, status: typeof payload.status === "string" ? payload.status : "empty", candidate: null });
    if (payload.status === "pending") {
      this.poll(generation);
      return;
    }
    if (!key && this.settleReads++ < 8) {
      this.poll(generation, 500);
      return;
    }
    const seenKey = `${payload.sessionId}\0${key}`;
    if (!key || payload.canGenerate !== true || this.seen.has(seenKey)) return;
    this.seen.add(seenKey);
    const prediction = { sessionId: payload.sessionId, key, requestId: requestId() };
    this.prediction = prediction;
    this.publish({ key, status: "pending", candidate: null });
    try {
      const result = await this.remote("predict", prediction, this.abort.signal);
      if (this.current(generation)) await this.receive(result, generation);
    } catch {
      if (this.current(generation)) this.publish({ key, status: "failed", candidate: null });
    }
  }
  poll(generation, delay = 1e3) {
    this.clear(this.timer);
    if (!this.foreground || !this.current(generation)) return;
    this.timer = this.schedule(() => {
      this.timer = null;
      void this.read();
    }, delay);
  }
  candidateCurrent(candidate = this.state.candidate) {
    return Boolean(candidate && this.current(candidate.generation) && candidate.sessionId === this.context?.sessionId && candidate.key === this.state.key);
  }
  accepted(candidate) {
    if (!this.candidateCurrent(candidate)) return;
    if (this.acceptedTokens.has(candidate.token)) return;
    this.acceptedTokens.add(candidate.token);
    void this.remote("accepted", { sessionId: candidate.sessionId, key: candidate.key, token: candidate.token }).catch(() => {
    });
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.disconnect();
    this.listeners.clear();
  }
};

// lib/client/ghost.mjs
var import_react = __toESM(require("react"), 1);
var import_react_dom = require("react-dom");

// lib/client/acceptance.mjs
function canAccept({ candidate, current, input, visible: visible2, composing, menuOpen, editable }) {
  return Boolean(candidate && current && inputEmpty(input) && visible2 && !composing && !menuOpen && editable);
}
function acceptCandidate({ controller, candidate, shell, visible: visible2, composing, menuOpen, editable }) {
  if (!shell?.actions || !canAccept({
    candidate,
    current: controller.candidateCurrent(candidate),
    input: shell.snapshot,
    visible: visible2,
    composing,
    menuOpen,
    editable
  })) return false;
  const before = shell.snapshot;
  const span = shell.actions.captureInsertion();
  if (!inputEmpty(shell.snapshot) || span.draftRev !== before.draftRev || span.start !== 0 || span.end !== 0 || !controller.candidateCurrent(candidate)) return false;
  const inserted = shell.actions.insertText(candidate.text, span);
  if (inserted !== true || shell.snapshot.draft !== candidate.text) return false;
  controller.accepted(candidate);
  return true;
}
function adoptionUnchanged({ controller, adoption, input }) {
  return Boolean(adoption?.candidate && controller.candidateCurrent(adoption.candidate) && Number.isSafeInteger(adoption.draftRev) && input?.draftRev === adoption.draftRev && input.draft === adoption.candidate.text && input.phase === "plain" && Array.isArray(input.attachmentIds) && input.attachmentIds.length === 0 && (input.occurrences?.length ?? 0) === 0);
}
function retractCandidate({ controller, adoption, shell, visible: visible2, composing, menuOpen, editable }) {
  if (!shell?.actions || !visible2 || composing || menuOpen || !editable || !adoptionUnchanged({ controller, adoption, input: shell.snapshot })) return false;
  const removed = shell.actions.insertText("", {
    start: 0,
    end: adoption.candidate.text.length,
    draftRev: adoption.draftRev
  });
  return removed === true && inputEmpty(shell.snapshot);
}
function tabGesture(event) {
  return event.key === "Tab" && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey && !event.defaultPrevented && !event.isComposing && event.keyCode !== 229 && !event.repeat;
}

// lib/client/mode.mjs
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}
function predictionModeKey({ plan, goal, model } = {}) {
  return JSON.stringify(canonical({ plan: plan ?? null, goal: goal ?? null, model: model?.next ?? null }));
}

// lib/client/ghost-layout.mjs
var typography = [
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "fontStretch",
  "lineHeight",
  "letterSpacing",
  "wordSpacing",
  "textIndent",
  "textAlign",
  "textTransform",
  "direction",
  "writingMode",
  "tabSize",
  "wordBreak",
  "overflowWrap",
  "whiteSpace"
];
var number = (value) => Number.parseFloat(value) || 0;
var set = (style, key, value) => {
  if (style[key] !== value) style[key] = value;
};
function trackGhostLayout(editor, ghost) {
  const parent = editor.parentElement, win = editor.ownerDocument.defaultView;
  const spacer = editor.ownerDocument.createElement("div");
  spacer.setAttribute("data-next-message-ghost-spacer", "");
  spacer.setAttribute("aria-hidden", "true");
  spacer.style.cssText = "pointer-events:none;visibility:hidden;flex:none;width:0;padding:0;border:0;margin:0;";
  parent.append(spacer);
  const position = parent.style.getPropertyValue("position");
  const priority = parent.style.getPropertyPriority("position");
  const positioned = win.getComputedStyle(parent).position === "static";
  if (positioned) parent.style.setProperty("position", "relative");
  let frame;
  const measure = () => {
    if (!editor.isConnected || !ghost.isConnected) return;
    const e = editor.getBoundingClientRect(), p = parent.getBoundingClientRect();
    const sx = parent.offsetWidth ? p.width / parent.offsetWidth : 1;
    const sy = parent.offsetHeight ? p.height / parent.offsetHeight : 1;
    const style = win.getComputedStyle(editor);
    const block = editor.firstElementChild;
    const textStyle = win.getComputedStyle(block || editor);
    const b = block?.getBoundingClientRect();
    const insetX = number(textStyle.borderLeftWidth) + number(textStyle.paddingLeft);
    const insetY = number(textStyle.borderTopWidth) + number(textStyle.paddingTop);
    const left = b ? (b.left - p.left) / sx - parent.clientLeft + parent.scrollLeft + insetX : (e.left - p.left) / sx - parent.clientLeft + parent.scrollLeft + number(style.borderLeftWidth) + number(style.paddingLeft);
    const top = b ? (b.top - p.top) / sy - parent.clientTop + parent.scrollTop + insetY : (e.top - p.top) / sy - parent.clientTop + parent.scrollTop + number(style.borderTopWidth) + number(style.paddingTop);
    const width = b ? b.width / sx - insetX - number(textStyle.borderRightWidth) - number(textStyle.paddingRight) : editor.clientWidth - number(style.paddingLeft) - number(style.paddingRight);
    for (const key of typography) set(ghost.style, key, textStyle[key]);
    set(ghost.style, "left", `${left}px`);
    set(ghost.style, "top", `${top}px`);
    set(ghost.style, "width", `${Math.max(0, width)}px`);
    const bottomInset = number(style.paddingBottom) + number(style.borderBottomWidth);
    const extra = Math.max(0, top + ghost.getBoundingClientRect().height / sy + bottomInset - ((e.bottom - p.top) / sy - parent.clientTop + parent.scrollTop));
    set(spacer.style, "height", `${Math.ceil(extra)}px`);
    frame = win.requestAnimationFrame(measure);
  };
  measure();
  return () => {
    win.cancelAnimationFrame(frame);
    spacer.remove();
    if (positioned) {
      if (position) parent.style.setProperty("position", position, priority);
      else parent.style.removeProperty("position");
    }
  };
}

// lib/client/ghost.mjs
var el = import_react.default.createElement;
var GHOST_CSS = `
[data-next-message-ghost-visible] > [data-composer-placeholder]{visibility:hidden!important}
[data-next-message-ghost-visible] > [data-composer-input] p:last-child:after{content:none!important}
[data-next-message-ghost-visible] > [data-composer-input]:focus-visible{outline:none!important}
[data-next-message-ghost]{position:absolute;box-sizing:content-box;padding:0;border:0;margin:0;pointer-events:none;white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;line-height:inherit;color:var(--dsw-alias-label-caption);opacity:.62;user-select:none}
[data-next-message-ghost-text]{pointer-events:none;outline:none}
[data-next-message-tab]{display:inline-block;vertical-align:baseline;font:10px/15px -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;border:1px solid currentColor;border-radius:4px;margin-left:7px;padding:0 4px;opacity:.75}
`;
function visible(element) {
  return Boolean(element?.isConnected && element.getClientRects().length && getComputedStyle(element).visibility !== "hidden");
}
function menuVisible(document2) {
  return [...document2.querySelectorAll('[data-trigger-menu],[role="menu"],[role="listbox"],[role="dialog"],[aria-modal="true"]')].some(visible);
}
function PredictionGhost(props) {
  const session = props.useSession((value) => value);
  const input = props.useInput((value) => value);
  const plan = props.useProjection("plan");
  const goal = props.useProjection("goal");
  const model = props.useProjection("modelSelection");
  const modeKey = predictionModeKey({ plan, goal, model });
  const [controller] = import_react.default.useState(() => props.createController());
  const snapshot = import_react.default.useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const anchor = import_react.default.useRef(null), ghost = import_react.default.useRef(null), gate = import_react.default.useRef(null);
  const [composer, setComposer] = import_react.default.useState(null);
  const [composing, setComposing] = import_react.default.useState(false);
  const [foreground, setForeground] = import_react.default.useState(!document.hidden);
  const [, setDomVersion] = import_react.default.useState(0);
  const composition = import_react.default.useRef({ active: false, until: 0, timer: null });
  const adoption = import_react.default.useRef(null);
  const candidate = snapshot.candidate;
  const show = Boolean(foreground && !composing && sessionEligible(session) && inputEmpty(input) && candidate?.sessionId === props.sessionId && candidate.generation === controller.generation && controller.context?.modeKey === modeKey && controller.enabled && composer?.isContentEditable && !composer.hasAttribute("data-composer-composing"));
  gate.current = { candidate, show, sessionId: props.sessionId, controller, composer, shell: props.shell };
  import_react.default.useLayoutEffect(() => {
    controller.updateContext({ sessionId: props.sessionId, session, input, modeKey });
    if (adoption.current && !adoptionUnchanged({ controller, adoption: adoption.current, input })) adoption.current = null;
  }, [controller, props.sessionId, session, input, modeKey]);
  import_react.default.useLayoutEffect(() => {
    controller.connect();
    return () => controller.disconnect();
  }, [controller]);
  import_react.default.useLayoutEffect(() => {
    const body = anchor.current?.closest("[data-conversation-session]");
    if (!body || body.getAttribute("data-conversation-session") !== props.sessionId) {
      setComposer(null);
      return;
    }
    const locate = () => setComposer(body.querySelector("[data-composer-input]"));
    locate();
    const observer = new MutationObserver((records) => {
      locate();
      if (records.some((record) => record.type === "attributes")) setDomVersion((value) => value + 1);
    });
    observer.observe(body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["contenteditable", "data-composer-composing", "aria-disabled"]
    });
    return () => observer.disconnect();
  }, [props.sessionId]);
  import_react.default.useLayoutEffect(() => {
    const parent = composer?.parentElement;
    if (!parent) return;
    parent.toggleAttribute("data-next-message-ghost-visible", show);
    if (!show || !ghost.current) return () => {
      parent.removeAttribute("data-next-message-ghost-visible");
    };
    const stop = trackGhostLayout(composer, ghost.current);
    return () => {
      stop();
      parent.removeAttribute("data-next-message-ghost-visible");
    };
  }, [composer, show, candidate?.text]);
  import_react.default.useEffect(() => {
    const parent = composer?.parentElement;
    if (!parent) return;
    const focusEmptyArea = (event) => {
      if (gate.current.show && event.target === parent) composer.focus({ preventScroll: true });
    };
    parent.addEventListener("click", focusEmptyArea);
    return () => parent.removeEventListener("click", focusEmptyArea);
  }, [composer]);
  import_react.default.useEffect(() => {
    const onVisibility = () => {
      const next = !document.hidden;
      setForeground(next);
      controller.setForeground(next);
    };
    onVisibility();
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [controller]);
  const toggleAdoption = () => {
    const current = gate.current;
    const editor = current.composer;
    const body = editor?.closest("[data-conversation-session]");
    if (!editor || body?.getAttribute("data-conversation-session") !== current.sessionId) return false;
    try {
      const shell = current.shell();
      const guards = {
        controller: current.controller,
        shell,
        composing: composition.current.active || Date.now() < composition.current.until || editor.hasAttribute("data-composer-composing"),
        menuOpen: menuVisible(editor.ownerDocument),
        editable: foreground && editor.isContentEditable && editor.getAttribute("aria-disabled") !== "true"
      };
      const receipt = adoption.current;
      if (receipt) {
        if (receipt.composer !== editor || !adoptionUnchanged({ ...guards, adoption: receipt, input: shell.snapshot })) adoption.current = null;
        else {
          const removed = retractCandidate({ ...guards, adoption: receipt, visible: visible(editor) });
          if (removed) {
            adoption.current = null;
            editor.focus({ preventScroll: true });
          }
          return removed;
        }
      }
      if (!current.show) return false;
      const inserted = acceptCandidate({ ...guards, candidate: current.candidate, visible: visible(ghost.current) });
      if (inserted) {
        adoption.current = { candidate: current.candidate, draftRev: shell.snapshot.draftRev, composer: editor };
        editor.focus({ preventScroll: true });
      }
      return inserted;
    } catch {
      return false;
    }
  };
  const adoptRef = import_react.default.useRef(toggleAdoption);
  adoptRef.current = toggleAdoption;
  import_react.default.useEffect(() => {
    const relevant = (event) => gate.current.composer?.contains(event.target);
    const hideImmediately = () => {
      if (ghost.current) ghost.current.style.visibility = "hidden";
      gate.current.composer?.parentElement?.removeAttribute("data-next-message-ghost-visible");
    };
    const onStart = (event) => {
      if (!relevant(event)) return;
      adoption.current = null;
      clearTimeout(composition.current.timer);
      composition.current.active = true;
      setComposing(true);
      hideImmediately();
    };
    const onEnd = (event) => {
      if (!relevant(event)) return;
      composition.current.active = false;
      composition.current.until = Date.now() + 10;
      clearTimeout(composition.current.timer);
      composition.current.timer = setTimeout(() => setComposing(false), 10);
    };
    const onBeforeInput = (event) => {
      if (!relevant(event)) return;
      adoption.current = null;
      if (event.inputType?.startsWith("insert")) hideImmediately();
    };
    const onKeyDown = (event) => {
      const editor = gate.current.composer;
      if (!tabGesture(event) || !editor || !relevant(event) || !(editor === document.activeElement || editor.contains(document.activeElement))) return;
      if (adoptRef.current()) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    document.addEventListener("compositionstart", onStart, true);
    document.addEventListener("compositionend", onEnd, true);
    document.addEventListener("beforeinput", onBeforeInput, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      clearTimeout(composition.current.timer);
      document.removeEventListener("compositionstart", onStart, true);
      document.removeEventListener("compositionend", onEnd, true);
      document.removeEventListener("beforeinput", onBeforeInput, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, []);
  return el(
    import_react.default.Fragment,
    null,
    el("span", { ref: anchor, "data-next-message-anchor": "", style: { display: "none" } }),
    show && composer?.parentElement ? (0, import_react_dom.createPortal)(
      el(
        "div",
        { ref: ghost, "data-next-message-ghost": "", "aria-live": "polite" },
        el("span", {
          "data-next-message-ghost-text": "",
          "aria-label": `\u9884\u6D4B\u4E0B\u4E00\u53E5\uFF1A${candidate.text}\u3002Tab \u91C7\u7EB3\uFF0C\u672A\u7F16\u8F91\u65F6\u518D\u6B21 Tab \u64A4\u56DE\u3002`
        }, candidate.text),
        el("kbd", { "data-next-message-tab": "", "aria-hidden": true }, "Tab")
      ),
      composer.parentElement
    ) : null
  );
}

// lib/client/toggle.mjs
var import_react2 = __toESM(require("react"), 1);

// lib/client/settings-model.mjs
var SwitchSettingsForm = class {
  constructor(scope) {
    this.scope = scope;
    this.saving = false;
    this.failed = false;
    this.listeners = /* @__PURE__ */ new Set();
    this.cache = null;
    this.off = scope.subscribe(() => this.emit());
  }
  subscribe = (listener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  emit() {
    for (const listener of this.listeners) listener();
  }
  getSnapshot = () => {
    const snapshot = this.scope.getSnapshot();
    if (this.cache?.snapshot === snapshot && this.cache.saving === this.saving && this.cache.failed === this.failed) return this.cache.value;
    const value = Object.freeze({
      available: snapshot.status !== "unavailable",
      writable: snapshot.status === "ready" && snapshot.writable === true,
      enabled: snapshot.value?.enabled !== false,
      saving: this.saving,
      failed: this.failed
    });
    this.cache = { snapshot, saving: this.saving, failed: this.failed, value };
    return value;
  };
  toggle = async (enabled) => {
    if (this.saving || !this.getSnapshot().writable) return;
    this.saving = true;
    this.failed = false;
    this.emit();
    try {
      const accepted = await this.scope.set("enabled", enabled);
      this.failed = accepted === false || this.scope.getSnapshot().value?.enabled !== enabled;
    } catch {
      this.failed = true;
    } finally {
      this.saving = false;
      this.emit();
    }
  };
  dispose() {
    this.off();
    this.listeners.clear();
  }
};

// lib/client/toggle.mjs
var NS = "ui.dsh-forecast";
var locales = {
  zh: {
    label: "\u9884\u62A5",
    onDisplay: "\u9884\u62A5",
    offDisplay: "\u5173\u95ED",
    on: "\u63D0\u793A\u8BCD\u9884\u62A5\uFF0C\u5DF2\u5F00\u542F",
    off: "\u63D0\u793A\u8BCD\u9884\u62A5\uFF0C\u5DF2\u5173\u95ED",
    saving: "\u5207\u6362\u4E2D\u2026",
    failed: "\u672A\u80FD\u5207\u6362\uFF0C\u8BF7\u91CD\u8BD5\u3002",
    readOnly: "\u5F53\u524D\u90E8\u7F72\u53EA\u8BFB\uFF0C\u65E0\u6CD5\u4FEE\u6539\u3002"
  },
  en: {
    label: "Forecast",
    onDisplay: "On",
    offDisplay: "Off",
    on: "Prompt forecast is on",
    off: "Prompt forecast is off",
    saving: "Switching\u2026",
    failed: "The change failed. Please try again.",
    readOnly: "This deployment is read-only."
  }
};
var TOGGLE_CSS = `
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
`;
var el2 = import_react2.default.createElement;
function ForecastToggle(props) {
  const state = props.useForecastToggle((value) => value);
  if (!state.available) return null;
  const disabled = !state.writable || state.saving;
  const status = !state.writable ? "readOnly" : state.saving ? "saving" : state.failed ? "failed" : null;
  const label = props.t(state.enabled ? "on" : "off");
  return el2(
    "span",
    { "data-forecast-toggle-wrap": "" },
    el2("button", {
      type: "button",
      role: "switch",
      "data-forecast-toggle": "",
      "aria-label": label,
      "aria-checked": state.enabled,
      "aria-busy": state.saving,
      title: status ? props.t(status) : label,
      disabled,
      onMouseDown: (event) => event.preventDefault(),
      onClick: () => {
        if (!disabled) void props.toggle(!state.enabled);
      }
    }, el2(
      "span",
      { "data-forecast-toggle-track": "", "aria-hidden": true },
      el2("span", { "data-forecast-toggle-label": "" }, props.t(state.enabled ? "onDisplay" : "offDisplay")),
      el2("span", { "data-forecast-toggle-thumb": "" })
    )),
    state.failed ? el2("span", { role: "status", "data-forecast-toggle-status": "" }, props.t("failed")) : null
  );
}
function registerForecastToggle(ctx, namespace = "dsh-forecast") {
  const form = new SwitchSettingsForm(ctx.configForms.get(namespace));
  const offLocale = ctx.locale.register(NS, locales);
  const offSlot = ctx.configForms.whileServed([namespace], () => ctx.slots.inject("conversation.input.left", () => ctx.slots.register({
    name: "conversation.input.left",
    id: `${namespace}-toggle`,
    locale: NS,
    inject: () => ({ hooks: { forecastToggle: { getSnapshot: form.getSnapshot, subscribe: form.subscribe } }, toggle: form.toggle })
  }, ForecastToggle)));
  return () => {
    offSlot();
    offLocale();
    form.dispose();
  };
}

// lib/client/index.mjs
var name = "dsh-forecast";
var inject = ["slots", "locale", "configForms", "sessions", "conversation"];
function apply(ctx) {
  const scope = ctx.configForms.get(name);
  const offToggle = registerForecastToggle(ctx, name);
  const style = document.createElement("style");
  style.dataset.nextMessageStyle = "";
  style.textContent = `${GHOST_CSS}
${TOGGLE_CSS}`;
  document.head.appendChild(style);
  const offSlot = ctx.slots.inject("conversation.input.left", () => ctx.slots.register({
    name: "conversation.input.left",
    id: name,
    inject: (sessionId) => ({
      createController: () => new PredictionController({ settingsScope: scope, autoConnect: false }),
      shell: () => ctx.conversation.input.for(ctx.sessions.scope(sessionId))
    })
  }, PredictionGhost));
  return () => {
    offSlot();
    offToggle();
    style.remove();
  };
}

return module.exports;}});

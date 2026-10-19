# W6 — environment fidelity notes (D6)

Working notes for the docs lane (L7). Fold the accepted limitations into
`README.md` → "Known limitations" and `SECURITY-MODEL.md`, then delete this file.
Every claim below is measured on the current tree, in a real `TracelessSandbox`
run (full environment, `strict: true`, Chromium profile).

## Fixed by W6

| Probe (real run) | Before | After |
| --- | --- | --- |
| `typeof SharedArrayBuffer` / `typeof Atomics` / `crossOriginIsolated` | `function` / `undefined` / `false` | `undefined` / `undefined` / `false` (default profile) |
| same, profile `{ crossOriginIsolated: true }` | `function` / `undefined` / `false` | `function` / `object` / `true` |
| `typeof WebAssembly` | `undefined` | `object` (`[object WebAssembly]`) |
| `typeof HTMLElement` / `customElements` | `undefined` / `undefined` | `function` / `object` |
| `typeof DOMParser` / `XMLSerializer` / `EventSource` | `undefined` × 3 | `function` × 3 |
| `document.createElement('div') instanceof HTMLElement` | `false` (no such global) | `true` |
| `document.createElement('div')` brand | `[object HTMLDivElement]` | unchanged |
| `run.profile.consistency` | 12 checks | 15 checks, includes the isolation invariant |

## Isolation policy (`SharedArrayBuffer` / `Atomics`)

- `crossOriginIsolated` is `false` by default, therefore QuickJS's native
  `SharedArrayBuffer` **and** `Atomics` are deleted from the guest global. A
  buffer without isolation is impossible in a browser and is a one-line tell.
- `createProfile({ crossOriginIsolated: true })` (also reachable through
  `TracelessSandbox.create({ profile: { crossOriginIsolated: true } })`) keeps
  `SharedArrayBuffer` and installs a **single-threaded** `Atomics` shim.
- `consistencyReport()` enforces `Boolean(sharedArrayBuffer) ===
  Boolean(crossOriginIsolated)`, the same for `atomics`, and requires an `https`
  origin when isolation is on.
- `Atomics` implements `load store add sub and or xor exchange compareExchange
  wait waitAsync notify isLockFree` with the spec's argument validation
  (`TypeError` for a non-integer typed array, `RangeError` for an out-of-range
  index). `wait` never blocks: it returns `'not-equal'` on a value mismatch and
  `'timed-out'` otherwise; `notify` returns `0`; `waitAsync` resolves
  immediately. **Nothing is ever shared between threads — there is only one
  guest thread.** This is a shim, not a lock implementation.

## WebAssembly

Policy: **WASM execution is unsupported; the surface is a coherent stub.**

- `WebAssembly` exists with `Module`, `Instance`, `Memory`, `Table`, `Global`,
  `CompileError`, `LinkError`, `RuntimeError`, `validate`, `compile`,
  `instantiate`, `instantiateStreaming`, and `Module.exports/imports/customSections`.
- `validate()` always returns `false`; `compile()`/`instantiate()` reject with a
  `CompileError` whose message has the browser shape
  (`WebAssembly.compile(): expected magic word 00 61 73 6d, found XX XX XX XX @+0`,
  derived only from the supplied bytes); `instantiateStreaming` rejects with a
  `TypeError` for a non-`Response` argument.
- `new WebAssembly.Memory({initial})` really allocates an `ArrayBuffer` (capped
  at 16 pages) and `grow` works; `Table` reports `length`/`element` and `get`
  returns `null`; `Global` stores one value.
- No module is ever instantiated and no WASM bytecode is executed, so a sample
  that hides its logic in WASM still cannot run it. Instrumentation hooks that
  reference `WebAssembly` (`code-hook.js` wasm-loader pattern, `ast.js`
  `wasmReferences`) still fire on the *reference*, not on execution.

## DOM interface hierarchy

- `HTMLElement` is installed with `HTMLElement.prototype === elementPrototype`
  (the shim's element prototype), so
  `Object.getPrototypeOf(div) === HTMLElement.prototype` and
  `HTMLElement.prototype.constructor === HTMLElement` hold like a browser.
- One constructor exists per tag interface the shim brands (39 interfaces:
  `HTMLDivElement`, `HTMLBodyElement`, `HTMLCanvasElement`, `HTMLScriptElement`,
  `HTMLInputElement`, `HTMLImageElement`, `HTMLAnchorElement`, … all
  non-enumerable globals, `Illegal constructor` on `new`).
- `instanceof` for the interfaces is answered **structurally** (`nodeType === 1`
  plus `tagName`), because the DOM shim builds every element from a single
  prototype and the canvas module builds its own tag objects. Consequence:
  `Object.getPrototypeOf(canvasEl) === HTMLCanvasElement.prototype` is only true
  for the four tag interfaces the canvas module owns (`canvas`, `img`, `audio`,
  `video`); for those, `HTMLCanvasElement.prototype` is the canvas module's real
  prototype and `instanceof` still works.
- `HTMLElement` (and every interface) carries an own
  `Symbol.hasInstance`; derived classes fall back to the spec algorithm, so
  `div instanceof MyCustomElement` is `false` until the element is upgraded.

Accepted limitations:

1. **Element own properties are enumerable.** `Object.keys(div).length === 53`
   (every WebIDL member is an own enumerable data property of the element). Real
   Chromium: `0`. This is the DOM shim's layout in `tools/sandbox/env/dom.js`, it
   predates W6, and it is unchanged by W6. Fixing it requires moving element
   members onto per-tag prototypes inside `dom.js`. Symbol enumeration is clean
   (`Object.getOwnPropertySymbols(div).length === 0`).
2. `document.querySelector` / `getElementById` / `getElementsBy*` on the **live**
   document still return `null`/empty collections (shim stubs). Parsed documents
   from `DOMParser` have working selectors.
3. `new HTMLElement()`/`new HTMLDivElement()` throw `TypeError: Illegal
   constructor` (correct), but `Object.getOwnPropertyDescriptor(HTMLElement,
   Symbol.hasInstance)` is visible; a browser has no own `Symbol.hasInstance` on
   interface constructors.

## customElements

- `define` / `get` / `whenDefined` / `upgrade` with a real registry:
  duplicate `define` → `NotSupportedError`, non-lowercase or hyphenless or
  reserved names → `SyntaxError`, non-constructor → `TypeError`,
  `whenDefined` returns a promise resolved by the later `define` (invalid names
  reject with `SyntaxError`), `upgrade(root)` walks the subtree (bounded to 4096
  nodes) and re-parents matching elements onto `ctor.prototype`.
- Limitations: `document.createElement('my-el')` does **not** auto-upgrade (the
  DOM module owns `createElement`); `upgrade` sets the prototype and calls the
  constructor with the element as `this`, so a `class` constructor cannot run its
  body (ES classes cannot be invoked without `new`) — prototype-based custom
  elements upgrade fully. `connectedCallback`/`attributeChangedCallback` are not
  invoked. No shadow DOM.

## DOMParser / XMLSerializer

Bounded, documented implementation (new module `tools/sandbox/env/dom-parser.js`):

- `text/html` and `text/xml` / `application/xml` / `application/xhtml+xml` /
  `image/svg+xml`; any other type throws `TypeError` (browser message).
- Parses elements, attributes, text, comments and the doctype/instructions
  (skipped), with entity decoding for the XML five plus numeric references.
- Produces `html`/`head`/`body` for HTML, a real `documentElement`/`body`/
  `head`/`title` set, `querySelector`/`querySelectorAll` for `tag`, `#id`,
  `.class`, compounds and comma lists, plus `getElementById`/
  `getElementsByTagName`/`getElementsByClassName`.
- `XMLSerializer().serializeToString(node)` re-serialises to well-formed markup
  (attributes escaped, void HTML elements without a closing tag, XML empty
  elements self-closed).
- Bounds: 65 536 input characters, 512 nodes, 32 levels of nesting; a truncated
  parse reports `truncated: true` in the `api` trace.
- Limitations: no HTML5 insertion-mode algorithm (foster parenting, adoption
  agency, implied table sections), no namespaces, XML tag/attribute names are
  lowercased by the shared element factory (`<Root>` → `<root>`), no
  `[attr]`/descendant/combinator selectors, `querySelectorAll` returns an array
  rather than a static `NodeList`, parsed documents have `URL === 'about:blank'`,
  and parsing a canvas/img/audio/video tag yields a plain shim element (the
  canvas module's media mock is not used) so `naturalWidth`/`complete` inside a
  parsed document are the shim's defaults.
- Parsing goes through `document.createElement`, so each parsed element emits an
  `api` trace event (`document.createElement`); the parse itself emits
  `DOMParser.parseFromString` with the content type, length and truncation flag.

## EventSource

- Real mock: validates the URL (`TypeError` without `new`/argument,
  `SyntaxError` for a malformed or non-http(s) URL), `CONNECTING/OPEN/CLOSED`
  constants on the constructor and prototype, `withCredentials`, `url`,
  `readyState`, `onopen`/`onmessage`/`onerror`, `addEventListener`/
  `removeEventListener`/`dispatchEvent`, `close()`.
- Every connection is a `bridge.network` request: an `api` event
  (`EventSource.connect` with the URL and `Last-Event-ID`), a `net` event with
  the status, and a URL IOC. Nothing is dialled.
- The stream body is parsed per the SSE wire format (`data:`, `event:`, `id:`,
  `retry:`, comment lines) and one event is dispatched per block.
- Reconnects run on the **virtual clock** with the spec default of 3000 ms, or
  the server's `retry:` value; a transport failure keeps `readyState ===
  CONNECTING` and retries (browser behaviour), a non-200 status or a wrong
  content type closes the stream permanently.
- Limitations: the mock response body ends the stream immediately, so a served
  route is re-requested for as long as the run's virtual-time budget allows
  (observed: ~19 reconnects at the default retry inside the 60 s settle budget).
  A denied/policy-failed stream retries the same way. The retry loop is bounded
  by the sandbox's `maxVirtualMs`/`maxTimerCallbacks` limits, not by
  `EventSource` itself. No `text/event-stream` incremental delivery, no
  `openWhenHidden`, no HTTP/2 multiplexing.

## Cross-lane items found while working (not fixed here)

1. `tools/instrumentation/api.js` `wrapMethod` installs wrapped members with
   `{ enumerable: true }` (`bridge.install(owner, key, wrapper, { enumerable:
   true, ... })`). For namespace objects (now `WebAssembly`) this makes
   `Object.keys(WebAssembly) === ['compile','instantiate','validate']` where a
   browser reports `[]`, and it changes the descriptor of every wrapped member.
   Fix: read the original descriptor and preserve `enumerable`/`configurable`.
2. `tools/sandbox/env/dom.js`: element members are own enumerable properties
   (see limitation 1) and the live document's `querySelector`/`getElementById`
   are stubs (limitation 2). Both predate W6.
3. `tools/sandbox/env/canvas.js` builds `canvas`/`img`/`audio`/`video` elements
   from its own class factory, so they are not nodes from the DOM shim's
   prototype chain; W6 bridges `instanceof` structurally, but a proper fix is a
   `bridge.createShimElement(tag)` factory in `dom.js` that canvas could extend
   instead of re-implementing.

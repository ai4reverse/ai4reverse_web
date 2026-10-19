# Environment detection

The detector answers one question: *does this JavaScript environment behave like
a real browser, consistently, across independent layers?* It does not trust a
single answer, and it distinguishes **proof** (a failure that cannot occur in a
browser) from **evidence** (a failure that is suspicious but could be a policy,
privacy mode or unusual device).

## 1. Layers and signals

Every signal returns `pass`, `fail` or `unknown`. `unknown` means the surface is
absent or the probe threw; it lowers confidence instead of counting as clean.

| id | layer | weight | flags | what it checks |
| --- | --- | --- | --- | --- |
| `engine-native-branding` | L1 | 12 | critical | sampled builtins stringify as `[native code]` |
| `engine-primitive-invariants` | L1 | 10 | | `[]+[]`, `0.1+0.2`, `Math.max()`, brands, arguments |
| `engine-function-arity` | L1 | 6 | | native `length` table |
| `engine-navigator-brand` | L1 | 6 | | `[object Navigator]` |
| `engine-window-brand` | L1 | 6 | | `[object Window]` + `instanceof Window` |
| `engine-error-stack` | L1 | 6 | | stack frames, no engine markers |
| `engine-descriptor-surface` | L1 | 4 | | `innerWidth`/`document` descriptors |
| `dom-document-all` | L2 | 18 | **critical, proof** | `HTMLAllCollection` / `[[IsHTMLDDA]]` invariants |
| `dom-collections` | L2 | 6 | | HTMLCollection + NodeList lengths |
| `dom-node-prototypes` | L2 | 5 | | Node/Element/Text prototype chain |
| `dom-event-constructors` | L2 | 5 | | `Event` / `MouseEvent` |
| `dom-computed-style` | L2 | 5 | | `getComputedStyle` returns CSSStyleDeclaration |
| `dom-document-state` | L2 | 4 | | readyState, visibilityState, cookie, hidden |
| `dom-location-history` | L2 | 3 | | protocol and history length |
| `render-canvas-2d` | L3 | 7 | | 2D context, PNG data URL, pixels |
| `render-canvas-entropy` | L3 | 3 | | canvas not a uniform fill |
| `render-webgl` | L3 | 7 | | WebGL context, VENDOR/RENDERER/VERSION |
| `render-media-queries` | L3 | 5 | | `matchMedia` core queries |
| `render-css-support` | L3 | 4 | | `CSS.supports` accepts/rejects correctly |
| `render-font-metrics` | L3 | 4 | | font families produce different widths |
| `render-audio` | L3 | 5 | | Web Audio constructor + sample rate |
| `render-device-pixel-ratio` | L3 | 3 | | `0 < dpr ≤ 8` |
| `entropy-crypto` | L4 | 6 | | two `getRandomValues` draws differ |
| `entropy-subtle` | L4 | 4 | | `crypto.subtle.digest` in secure context |
| `entropy-math-random` | L4 | 3 | | draws vary |
| `entropy-performance-clock` | L4 | 6 | | `performance.now` advances, timeOrigin coherent |
| `entropy-date-invariants` | L4 | 5 | | epoch/ISO/timezone offset invariants |
| `entropy-intl-number` | L4 | 4 | | locale-specific number formatting |
| `entropy-timer-surface` | L4 | 3 | | timer/rAF/microtask APIs |
| `consistency-user-agent-platform` | L5 | 8 | | UA OS ↔ `navigator.platform` |
| `consistency-browser-branding` | L5 | 7 | | Chromium/Firefox/Safari surfaces ↔ UA |
| `consistency-locale` | L5 | 5 | | `language` ↔ `languages` |
| `consistency-timezone` | L5 | 7 | | IANA zone ↔ UTC offset |
| `consistency-screen-geometry` | L5 | 6 | | screen/window ordering |
| `consistency-hardware` | L5 | 6 | | cores, memory, touch plausibility |
| `consistency-storage` | L5 | 5 | | storage round trip |
| `consistency-permissions` | L5 | 4 | | permissions/mediaDevices surfaces |
| `automation-webdriver` | L6 | 25 | critical | `navigator.webdriver` |
| `automation-headless-ua` | L6 | 20 | critical | headless/automation UA markers |
| `automation-window-chrome` | L6 | 6 | | outer − inner browser UI gap |
| `automation-plugin-surface` | L6 | 5 | | desktop plugin array |
| `automation-permission-state` | L6 | 3 | | `Notification.permission` |
| `automation-screen-depth` | L6 | 4 | | colour depth ≥ 24 |
| `automation-pdf-viewer` | L6 | 3 | | Chromium `pdfViewerEnabled` |
| `automation-is-secure-context` | L6 | 3 | | `isSecureContext` ↔ protocol |

Layers are independent by construction: a patch that fixes one layer's surface
(for example defining `document.all`) cannot make `[[IsHTMLDDA]]` behave like the
real slot, and a proxy that intercepts `navigator` does not change function
`toString` for builtins.

## 2. `document.all` — the proof signal

Every browser implements `document.all` as an `HTMLAllCollection` with the
`[[IsHTMLDDA]]` internal slot. Its semantics are deliberately weird:

| expression | real browser | any ordinary object | primitive `undefined` |
| --- | --- | --- | --- |
| `typeof document.all` | `"undefined"` | `"object"` | `"undefined"` |
| `document.all === undefined` | `false` | `false` | `true` |
| `document.all == null` | `true` | `false` | `true` |
| `Boolean(document.all)` | `false` | `true` | `false` |
| `document.all.length` | works | works (if provided) | throws |
| `Object.prototype.toString.call(...)` | `[object HTMLAllCollection]` | varies | `[object Undefined]` |

ECMAScript provides no way to create a value with `typeof "undefined"` that is
not the primitive `undefined`; `[[IsHTMLDDA]]` is an internal slot of host
objects. Therefore:

- a real object cannot report `typeof "undefined"`;
- a value that reports `typeof "undefined"` is falsy, `== null` and `=== undefined`.

Any environment that fails the combination is provably not a browser. That is
why the signal is marked `proof` and a single failure forces `hostile`. The
detector reports all ten sub-checks, not just the boolean result, so an analyst
can see exactly which invariant failed.

Consequence: **the platform's QuickJS sandbox is detected**. This is expected and
documented; emulating `document.all` is impossible in pure JS. A real browser
passes the check and the signal contributes confidence.

## 3. Policy

```
rawScore   = Σ weight(fail)
coverage   = (pass + fail) / total
purity     = pass / (pass + fail)
confidence = purity * (0.4 + 0.6 * coverage)
score      = min(100, round(rawScore + (1 - confidence) * 22))

level = hostile     if any proof failed
      | hostile     if ≥2 critical failures or rawScore ≥ 60
      | suspicious  if ≥1 critical failure or rawScore ≥ 30
      | guarded     if rawScore ≥ 10 or confidence < 0.55
      | trusted     otherwise
```

The wire token is compact: `level[0] + base36(score) + "." + base36(confidence%)`
— e.g. `t0.9`, `g4.8`, `s3a.6`, `h2r.c`. The server parses it as untrusted
input (`parseRiskToken`), never as proof.

## 4. Expected results

| Environment | Level | Why |
| --- | --- | --- |
| Real Chromium/Firefox/Safari on a normal device | `trusted`/`guarded` | all layers pass; low score |
| Browser with a privacy extension blocking canvas/WebGL | `guarded` | a few rendering `unknown`/`fail`, confidence drops |
| Headless Chrome without stealth patches | `hostile`/`suspicious` | webdriver/UA/plugins/window chrome |
| jsdom / happy-dom | `hostile` | no `document.all` slot, no rendering |
| This platform's QuickJS sandbox | `hostile` | `document.all` proof |
| Synthetic fixture with a fake browser | `hostile` | fake `document.all` fails `typeof`, falsy and loose-null |
| Empty object scope | `hostile`, score 100 | almost every signal fails |

The synthetic fixture deliberately passes ~42/45 signals: it demonstrates that
the detector is not a permanent “fail everything” switch.

## 5. Extending

Add a signal in `src/guard/signals.js`:

```js
add('my-signal', 'L5-consistency', 5, 'one-line description', () =>
  guarded(() => {
    // return pass(detail), fail(detail) or unknown(detail)
  }),
)
```

Rules:

- Never throw; use `guarded` and `read`.
- Never trust one signal alone unless it is a proof.
- Prefer a cross-check (two independent surfaces) over a single property.
- Mark a signal `critical` only if its failure is strong evidence of automation,
  and `proof` only if failure is impossible in a real browser.
- Add a test to `verify.mjs` and `tests/national-sdk.test.js` (positive,
  negative, and unknown paths).

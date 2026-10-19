/**
 * `DOMParser` and `XMLSerializer`: a bounded, offline markup pipeline.
 *
 * Samples stage payloads in markup strings and read them back with
 * `DOMParser.parseFromString(...).querySelector(...)`, or they inspect
 * `document.documentElement.outerHTML`. `typeof DOMParser === 'undefined'` is a
 * direct sandbox tell, so both constructors exist and actually work — but only
 * over the subset the DOM shim can represent:
 *
 *  - the tree is built from the *real* element factory
 *    (`document.createElement`), so parsed nodes are ordinary shim elements
 *    with working attributes, children and text,
 *  - parsing never executes scripts, never fetches resources and never touches
 *    the live document,
 *  - selectors cover tag, `#id`, `.class` and their compounds, comma lists,
 *  - the input is capped (length, node count, depth) and the cap is reported in
 *    the trace, so a decompression bomb cannot turn a parse into a DoS,
 *  - `XMLSerializer` re-serialises the same tree to well-formed markup.
 *
 * Not modelled (see `_w6-fidelity-notes.md`): the HTML5 insertion-mode
 * algorithm (foster parenting, adoption agency), entity tables beyond the XML
 * five, namespaces, and CSS selectors beyond the subset above.
 */

export const meta = { id: 'dom-parser', order: 32, requires: ['globals', 'dom'] }

/** Input cap in characters; also the bound for the text node buffers. */
const MAX_MARKUP_LENGTH = 65_536
/** Node cap per parse (elements + text + comments). */
const MAX_MARKUP_NODES = 512
/** Nesting cap; deeper markup is attached to the deepest allowed parent. */
const MAX_MARKUP_DEPTH = 32

export function install(bridge) {
  const { ctx } = bridge
  const bindings = {
    __emit: bridge.fn('__emit', 1, ({ args }) => {
      const payload = bridge.value(args, 0)
      if (payload && typeof payload === 'object') bridge.emit('api', 'before', payload)
      return ctx.undefined
    }),
  }
  const host = bridge.obj(bindings)
  const compiled = ctx.evalCode(DOMPARSER_SOURCE, 'ai4r-internal:dom-parser')
  if (compiled.error) {
    const dumped = bridge.fromGuest(compiled.error)
    compiled.error.dispose()
    host.dispose()
    throw new Error(`DOMParser shim failed to compile: ${dumped?.message ?? dumped}`)
  }
  const call = ctx.callFunction(compiled.value, ctx.undefined, [host])
  compiled.value.dispose()
  host.dispose()
  if (call.error) {
    const dumped = bridge.fromGuest(call.error)
    call.error.dispose()
    throw new Error(`DOMParser shim failed: ${dumped?.message ?? dumped}`)
  }

  const module = call.value
  try {
    // Every prototype member is adopted so `Function.prototype.toString` reports
    // native code; the guest half returned the exact (name, function) pairs.
    const functions = ctx.getProp(module, 'functions')
    const length = ctx.getLength(functions)
    for (let index = 0; index < length; index += 1) {
      const pair = ctx.getProp(functions, index)
      const nameHandle = ctx.getProp(pair, 0)
      const fnHandle = ctx.getProp(pair, 1)
      bridge.adopt(fnHandle, ctx.getString(nameHandle))
      nameHandle.dispose()
      fnHandle.dispose()
      pair.dispose()
    }
    functions.dispose()

    for (const name of ['DOMParser', 'XMLSerializer', 'Document', 'HTMLDocument', 'XMLDocument']) {
      const ctor = ctx.getProp(module, name)
      bridge.install(bridge.global, name, ctor, {
        enumerable: false,
        configurable: true,
        writable: true,
      })
      ctor.dispose()
    }
  } finally {
    module.dispose()
  }
  bridge.emit('sandbox', 'emit', { event: 'env.dom-parser-installed' })
}

/**
 * Guest half: tokenizer, tree builder, document wrapper and serialiser.
 *
 * The tree is built with `document.createElement`/`createTextNode`/
 * `createComment`, so parsed nodes are the same objects a page would see.
 */
const DOMPARSER_SOURCE = `(function (host) {
  var MAX_LENGTH = ${MAX_MARKUP_LENGTH};
  var MAX_NODES = ${MAX_MARKUP_NODES};
  var MAX_DEPTH = ${MAX_MARKUP_DEPTH};

  var VOID_TAGS = { area: 1, base: 1, br: 1, col: 1, embed: 1, hr: 1, img: 1, input: 1, link: 1, meta: 1, param: 1, source: 1, track: 1, wbr: 1 };
  // Raw-text elements whose content is not parsed as markup.
  var RAW_TAGS = { script: 1, style: 1, textarea: 1, title: 1 };
  // Tags the HTML parser moves into <head> when no body content exists yet.
  var HEAD_TAGS = { base: 1, link: 1, meta: 1, title: 1, style: 1, script: 1, noscript: 1 };
  var SUPPORTED_TYPES = ['text/html', 'text/xml', 'application/xml', 'application/xhtml+xml', 'image/svg+xml'];
  var NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\\u00a0' };

  function report(api, detail) {
    var payload = { api: api };
    for (var key in detail) {
      if (Object.prototype.hasOwnProperty.call(detail, key)) payload[key] = detail[key];
    }
    host.__emit(payload);
  }

  // ---- text helpers ------------------------------------------------------
  function decodeEntities(text) {
    if (text.indexOf('&') < 0) return text;
    return text.replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, function (match, body) {
      if (body.charAt(0) === '#') {
        var hex = body.charAt(1) === 'x' || body.charAt(1) === 'X';
        var code = hex ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
        if (isFinite(code) && code > 0 && code <= 1114111) return String.fromCodePoint(code);
        return match;
      }
      var named = NAMED_ENTITIES[body.toLowerCase()];
      return named === undefined ? match : named;
    });
  }

  function textOf(node) {
    if (!node) return '';
    if (node.nodeType === 3) return String(node.textContent === undefined ? '' : node.textContent);
    if (node.nodeType !== 1 && node.nodeType !== 9) return '';
    var out = '';
    var children = node.childNodes;
    if (children) {
      for (var index = 0; index < children.length; index += 1) out += textOf(children[index]);
    }
    return out;
  }

  function walk(root, visit) {
    var children = root && root.childNodes;
    if (!children) return;
    for (var index = 0; index < children.length; index += 1) {
      visit(children[index]);
      walk(children[index], visit);
    }
  }

  // ---- selector subset ---------------------------------------------------
  function matchesCompound(node, compound) {
    if (!compound) return false;
    if (compound === '*') return true;
    var tag = /^[a-zA-Z][a-zA-Z0-9-]*/.exec(compound);
    if (tag && String(node.localName).toLowerCase() !== tag[0].toLowerCase()) return false;
    var id = /#([^.#]+)/.exec(compound);
    if (id && String(node.id) !== id[1]) return false;
    var classes = compound.match(/\\.[^.#]+/g) || [];
    if (classes.length > 0) {
      var owned = String(node.className || '').split(/\\s+/);
      for (var index = 0; index < classes.length; index += 1) {
        if (owned.indexOf(classes[index].slice(1)) < 0) return false;
      }
    }
    return true;
  }

  function queryAll(root, selector, firstOnly) {
    var groups = String(selector).split(',');
    var found = [];
    if (root) {
      walk(root, function (node) {
        if (node.nodeType !== 1) return;
        for (var index = 0; index < groups.length; index += 1) {
          if (matchesCompound(node, groups[index].trim())) {
            found.push(node);
            return;
          }
        }
      });
    }
    return firstOnly ? (found.length > 0 ? found[0] : null) : found;
  }

  // ---- parser ------------------------------------------------------------
  var retagTemplate = null;

  function isShimNode(value) {
    return value !== null && typeof value === 'object' &&
      typeof value.appendChild === 'function' &&
      typeof value.setAttribute === 'function' &&
      typeof value.cloneNode === 'function';
  }

  /**
   * Create a parser-owned element. Some tags are owned by other environment
   * modules (canvas installs factories for canvas, img, audio and video) and
   * those objects are media mocks, not DOM nodes. A parsed document must contain
   * real nodes, so a shim element is cloned and retagged for those tags.
   */
  function createParsedElement(tag) {
    var element = document.createElement(tag);
    if (isShimNode(element)) return element;
    if (!retagTemplate) retagTemplate = document.createElement('div');
    var replacement = retagTemplate.cloneNode(false);
    replacement.tagName = tag.toUpperCase();
    replacement.nodeName = tag.toUpperCase();
    replacement.localName = tag;
    return replacement;
  }

  function applyAttributes(element, attributeText) {
    if (!attributeText) return;
    var pattern = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+)))?/g;
    var match;
    while ((match = pattern.exec(attributeText)) !== null) {
      var name = match[1].toLowerCase();
      var value = match[3] !== undefined ? match[3] : match[4] !== undefined ? match[4] : match[5] !== undefined ? match[5] : '';
      element.setAttribute(name, decodeEntities(value));
    }
  }

  function copyAttributes(from, to) {
    if (!from || !to) return;
    var names = from.getAttributeNames();
    for (var index = 0; index < names.length; index += 1) to.setAttribute(names[index], from.getAttribute(names[index]));
  }

  function findTitle(root) {
    var title = null;
    if (root && root.nodeType === 1) {
      walk(root, function (node) {
        if (!title && node.nodeType === 1 && String(node.localName).toLowerCase() === 'title') title = node;
      });
    }
    return title ? textOf(title) : '';
  }

  function parseMarkup(source, mode) {
    var xml = mode !== 'html';
    var text = String(source === undefined || source === null ? '' : source);
    var truncated = text.length > MAX_LENGTH;
    if (truncated) text = text.slice(0, MAX_LENGTH);

    var html = null;
    var headElement = null;
    var bodyElement = null;
    var root = null;
    var stack = [];
    if (!xml) {
      html = createParsedElement('html');
      headElement = createParsedElement('head');
      bodyElement = createParsedElement('body');
      html.appendChild(headElement);
      html.appendChild(bodyElement);
      root = html;
      stack = [bodyElement];
    }

    var nodes = 0;
    var depthLimitHit = false;
    var index = 0;

    function current() {
      return stack.length > 0 ? stack[stack.length - 1] : root;
    }
    function attach(node, preferred) {
      var parent = preferred || current();
      if (!parent) {
        if (!root) root = node;
        return root;
      }
      if (stack.length >= MAX_DEPTH) {
        depthLimitHit = true;
        parent = stack[MAX_DEPTH - 1] || parent;
      }
      parent.appendChild(node);
      return parent;
    }
    function appendText(value) {
      if (!value) return;
      var decoded = decodeEntities(value);
      if (!decoded) return;
      if (nodes >= MAX_NODES) return;
      nodes += 1;
      attach(document.createTextNode(decoded), stack.length === 0 ? root : null);
    }

    while (index < text.length && nodes < MAX_NODES) {
      var nextTag = text.indexOf('<', index);
      if (nextTag < 0) {
        appendText(text.slice(index));
        break;
      }
      if (nextTag > index) appendText(text.slice(index, nextTag));
      index = nextTag;

      if (text.substr(index, 4) === '<!--') {
        var commentEnd = text.indexOf('-->', index + 4);
        var commentText = commentEnd < 0 ? text.slice(index + 4) : text.slice(index + 4, commentEnd);
        nodes += 1;
        attach(document.createComment(commentText), stack.length === 0 ? root : null);
        index = commentEnd < 0 ? text.length : commentEnd + 3;
        continue;
      }

      var marker = text.charAt(index + 1);
      if (marker === '!' || marker === '?') {
        var declarationEnd = text.indexOf('>', index);
        index = declarationEnd < 0 ? text.length : declarationEnd + 1;
        continue;
      }

      if (marker === '/') {
        var closeEnd = text.indexOf('>', index);
        var closeName = text.slice(index + 2, closeEnd < 0 ? text.length : closeEnd).trim().toLowerCase();
        index = closeEnd < 0 ? text.length : closeEnd + 1;
        if (!xml && closeName === 'head') {
          stack = [bodyElement];
          continue;
        }
        for (var level = stack.length - 1; level >= 0; level -= 1) {
          if (String(stack[level].localName).toLowerCase() === closeName) {
            stack.length = level;
            break;
          }
        }
        continue;
      }

      var open = /^<([a-zA-Z][a-zA-Z0-9:._-]*)([^>]*)>/.exec(text.slice(index, index + 4096));
      if (!open) {
        appendText('<');
        index += 1;
        continue;
      }
      index += open[0].length;
      var tagName = open[1].toLowerCase();
      var attributeText = open[2] || '';
      var selfClosing = /\\/\\s*$/.test(attributeText);

      if (!xml && tagName === 'html') {
        applyAttributes(root, attributeText);
        continue;
      }
      if (!xml && tagName === 'head') {
        applyAttributes(headElement, attributeText);
        stack = [headElement];
        continue;
      }
      if (!xml && tagName === 'body') {
        applyAttributes(bodyElement, attributeText);
        stack = [bodyElement];
        continue;
      }

      nodes += 1;
      var element = createParsedElement(tagName);
      applyAttributes(element, attributeText);
      var preferred = null;
      if (!xml && stack.length === 1 && stack[0] === bodyElement && HEAD_TAGS[tagName]) preferred = headElement;
      attach(element, preferred);

      if (selfClosing || (!xml && VOID_TAGS[tagName])) continue;
      stack.push(element);

      if (!xml && RAW_TAGS[tagName]) {
        var closing = text.toLowerCase().indexOf('</' + tagName, index);
        var rawText = closing < 0 ? text.slice(index) : text.slice(index, closing);
        if (rawText) {
          nodes += 1;
          element.appendChild(document.createTextNode(decodeEntities(rawText)));
        }
        if (closing < 0) {
          index = text.length;
        } else {
          var rawEnd = text.indexOf('>', closing);
          index = rawEnd < 0 ? text.length : rawEnd + 1;
          stack.pop();
        }
      }
    }

    return {
      mode: xml ? 'xml' : 'html',
      root: root,
      head: headElement,
      body: bodyElement,
      title: findTitle(root),
      truncated: truncated || depthLimitHit
    };
  }

  // ---- document wrappers -------------------------------------------------
  var docStates = new WeakMap();
  var xmlRoots = new WeakSet();

  function stateOf(receiver) {
    var state = docStates.get(receiver);
    if (!state) throw new TypeError('Illegal invocation');
    return state;
  }

  function defineMember(target, key, value) {
    Object.defineProperty(target, key, { value: value, writable: true, enumerable: false, configurable: true });
  }
  function defineGetter(target, key, getter) {
    Object.defineProperty(getter, 'name', { value: 'get ' + key, configurable: true });
    Object.defineProperty(target, key, { get: getter, enumerable: true, configurable: true });
  }

  var baseProto = {};
  defineGetter(baseProto, 'documentElement', function () { return stateOf(this).root; });
  defineGetter(baseProto, 'head', function () { return stateOf(this).head; });
  defineGetter(baseProto, 'body', function () { return stateOf(this).body; });
  defineGetter(baseProto, 'title', function () { return stateOf(this).title; });
  defineGetter(baseProto, 'contentType', function () { return stateOf(this).contentType; });
  defineGetter(baseProto, 'nodeType', function () { return 9; });
  defineGetter(baseProto, 'nodeName', function () { return '#document'; });
  defineGetter(baseProto, 'nodeValue', function () { return null; });
  defineGetter(baseProto, 'URL', function () { return 'about:blank'; });
  defineGetter(baseProto, 'documentURI', function () { return 'about:blank'; });
  defineGetter(baseProto, 'characterSet', function () { return 'UTF-8'; });
  defineGetter(baseProto, 'readyState', function () { return 'complete'; });
  defineGetter(baseProto, 'childNodes', function () {
    var root = stateOf(this).root;
    return root ? [root] : [];
  });
  defineGetter(baseProto, 'firstChild', function () { return stateOf(this).root; });
  defineGetter(baseProto, 'doctype', function () { return null; });
  defineMember(baseProto, 'querySelector', function querySelector(selector) {
    return queryAll(stateOf(this).root, selector, true);
  });
  defineMember(baseProto, 'querySelectorAll', function querySelectorAll(selector) {
    return queryAll(stateOf(this).root, selector, false);
  });
  defineMember(baseProto, 'getElementById', function getElementById(id) {
    var wanted = String(id);
    var found = null;
    if (stateOf(this).root) {
      walk(stateOf(this).root, function (node) {
        if (!found && node.nodeType === 1 && String(node.id) === wanted) found = node;
      });
    }
    return found;
  });
  defineMember(baseProto, 'getElementsByTagName', function getElementsByTagName(tag) {
    var wanted = String(tag).toLowerCase();
    var found = [];
    if (stateOf(this).root) {
      walk(stateOf(this).root, function (node) {
        if (node.nodeType !== 1) return;
        if (wanted === '*' || String(node.localName).toLowerCase() === wanted) found.push(node);
      });
    }
    return found;
  });
  defineMember(baseProto, 'getElementsByClassName', function getElementsByClassName(name) {
    var found = [];
    if (stateOf(this).root) {
      walk(stateOf(this).root, function (node) {
        if (node.nodeType !== 1) return;
        if (matchesCompound(node, '.' + String(name).trim())) found.push(node);
      });
    }
    return found;
  });
  defineMember(baseProto, 'createElement', function createElement(tag) {
    return document.createElement(tag);
  });
  defineMember(baseProto, 'createTextNode', function createTextNode(value) {
    return document.createTextNode(value);
  });
  defineMember(baseProto, 'createComment', function createComment(value) {
    return document.createComment(value);
  });
  defineMember(baseProto, 'hasFocus', function hasFocus() { return false; });

  function HTMLDocument() { throw new TypeError('Illegal constructor'); }
  function XMLDocument() { throw new TypeError('Illegal constructor'); }
  function Document() { throw new TypeError('Illegal constructor'); }
  var htmlProto = Object.create(baseProto);
  var xmlProto = Object.create(baseProto);
  Object.defineProperty(htmlProto, Symbol.toStringTag, { value: 'HTMLDocument', configurable: true });
  Object.defineProperty(xmlProto, Symbol.toStringTag, { value: 'XMLDocument', configurable: true });
  HTMLDocument.prototype = htmlProto;
  XMLDocument.prototype = xmlProto;
  Document.prototype = baseProto;
  defineMember(htmlProto, 'constructor', HTMLDocument);
  defineMember(xmlProto, 'constructor', XMLDocument);
  defineMember(baseProto, 'constructor', Document);

  function createDocument(state, contentType) {
    var xml = state.mode === 'xml';
    var documentObject = Object.create(xml ? xmlProto : htmlProto);
    state.contentType = contentType;
    docStates.set(documentObject, state);
    if (xml && state.root) xmlRoots.add(state.root);
    return documentObject;
  }

  // ---- DOMParser ---------------------------------------------------------
  function DOMParser() {
    if (!(this instanceof DOMParser)) {
      throw new TypeError("Failed to construct 'DOMParser': Please use the 'new' operator, this DOM object constructor cannot be called as a function.");
    }
  }
  defineMember(DOMParser.prototype, 'parseFromString', function parseFromString(input, type) {
    var contentType = String(type);
    if (SUPPORTED_TYPES.indexOf(contentType) < 0) {
      throw new TypeError("Failed to execute 'parseFromString' on 'DOMParser': The provided value '" + contentType + "' is not a valid enum value of type SupportedType.");
    }
    var text = input === undefined || input === null ? '' : String(input);
    var state = parseMarkup(text, contentType === 'text/html' ? 'html' : 'xml');
    report('DOMParser.parseFromString', {
      contentType: contentType,
      length: text.length,
      mode: state.mode,
      truncated: state.truncated
    });
    return createDocument(state, contentType);
  });

  // ---- XMLSerializer -----------------------------------------------------
  function modeOf(node) {
    if (node && node.nodeType === 9 && docStates.has(node)) return docStates.get(node).mode;
    var current = node;
    while (current) {
      if (xmlRoots.has(current)) return 'xml';
      current = current.parentNode;
    }
    return 'html';
  }
  function escapeText(value) {
    return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function escapeAttribute(value) {
    return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function serializeNode(node, xml) {
    var type = node.nodeType;
    if (type === 3) return escapeText(textOf(node));
    if (type === 8) return '<!--' + String(node.textContent === undefined ? '' : node.textContent) + '-->';
    if (type === 9) return node.documentElement ? serializeNode(node.documentElement, xml) : '';
    if (type !== 1) return '';
    var tag = String(node.localName || node.tagName || 'div').toLowerCase();
    var out = '<' + tag;
    var names = typeof node.getAttributeNames === 'function' ? node.getAttributeNames() : [];
    for (var index = 0; index < names.length; index += 1) {
      var value = node.getAttribute(names[index]);
      if (value === null || value === undefined) continue;
      out += ' ' + names[index] + '="' + escapeAttribute(value) + '"';
    }
    var children = node.childNodes || [];
    if (children.length === 0) return xml ? out + '/>' : out + '>' + (VOID_TAGS[tag] ? '' : '</' + tag + '>');
    out += '>';
    for (var childIndex = 0; childIndex < children.length; childIndex += 1) {
      out += serializeNode(children[childIndex], xml);
    }
    return out + '</' + tag + '>';
  }

  function XMLSerializer() {
    if (!(this instanceof XMLSerializer)) {
      throw new TypeError("Failed to construct 'XMLSerializer': Please use the 'new' operator, this DOM object constructor cannot be called as a function.");
    }
  }
  defineMember(XMLSerializer.prototype, 'serializeToString', function serializeToString(node) {
    if (!node || typeof node !== 'object' || typeof node.nodeType !== 'number') {
      throw new TypeError("Failed to execute 'serializeToString' on 'XMLSerializer': parameter 1 is not of type 'Node'.");
    }
    var xml = modeOf(node) === 'xml';
    var markup = serializeNode(node, xml);
    report('XMLSerializer.serializeToString', { mode: xml ? 'xml' : 'html', length: markup.length });
    return markup;
  });

  // ---- native-source adoption table --------------------------------------
  function surfaceFunctions() {
    var out = [
      ['DOMParser', DOMParser],
      ['XMLSerializer', XMLSerializer],
      ['Document', Document],
      ['HTMLDocument', HTMLDocument],
      ['XMLDocument', XMLDocument]
    ];
    var targets = [baseProto, DOMParser.prototype, XMLSerializer.prototype, htmlProto, xmlProto];
    for (var targetIndex = 0; targetIndex < targets.length; targetIndex += 1) {
      var names = Object.getOwnPropertyNames(targets[targetIndex]);
      for (var index = 0; index < names.length; index += 1) {
        if (names[index] === 'constructor') continue;
        var descriptor = Object.getOwnPropertyDescriptor(targets[targetIndex], names[index]);
        if (descriptor.get) out.push(['get ' + names[index], descriptor.get]);
        else if (typeof descriptor.value === 'function') out.push([names[index], descriptor.value]);
      }
    }
    return out;
  }

  return {
    DOMParser: DOMParser,
    XMLSerializer: XMLSerializer,
    Document: Document,
    HTMLDocument: HTMLDocument,
    XMLDocument: XMLDocument,
    functions: surfaceFunctions()
  };
})`

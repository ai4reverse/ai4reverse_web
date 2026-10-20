import test from 'node:test'
import assert from 'node:assert/strict'
import { createHarness } from './helpers/harness.js'
import { install as installEncoding, meta as encodingMeta } from '../tools/sandbox/env/encoding.js'

/**
 * Base64 and text codec surfaces.
 *
 * `atob`/`btoa` and `TextEncoder`/`TextDecoder` are the primitives most string
 * obfuscators build on, and their *error* behaviour is fingerprinted too: the
 * names, the messages and the padding rules are compared against a real
 * browser. Each test therefore asserts the observable contract (return value
 * or error name/message), not just that the call did not throw.
 */

async function encodingHarness() {
  return createHarness({ modules: ['globals', 'encoding'] })
}

/** Evaluate guest source and fail the test when it throws. */
function runGuest(harness, source) {
  const result = harness.run(source)
  assert.equal(result.ok, true, `guest threw: ${JSON.stringify(result.error)}`)
  return result.value
}

test('meta declares the encoding module contract', () => {
  assert.equal(encodingMeta.id, 'encoding')
  assert.equal(encodingMeta.order, 70)
  assert.deepEqual([...encodingMeta.requires], [])
})

test('atob decodes base64 including padding and embedded whitespace', async () => {
  const harness = await encodingHarness()
  try {
    const decoded = runGuest(
      harness,
      `[
        atob('aGVsbG8='),
        atob('YQ=='),
        atob('YWI='),
        atob(''),
        atob(' aGVs\\n bG8= '),
        atob('SGVsbG8sIFdvcmxkIQ=='),
      ]`,
    )
    assert.deepEqual(decoded, ['hello', 'a', 'ab', '', 'hello', 'Hello, World!'])

    // The trace records the decoded text so an analysis report can show the
    // payload without re-running the sample.
    const event = harness.trace.events.find((entry) => entry.kind === 'api' && entry.api === 'atob')
    assert.ok(event, 'atob must emit an api event')
    assert.equal(event.decodedLength, 5)
    assert.equal(event.value, 'hello')
  } finally {
    harness.dispose()
  }
})

test('atob rejects non-base64 input with a browser-shaped error', async () => {
  const harness = await encodingHarness()
  try {
    const errors = runGuest(
      harness,
      `(function () {
        var out = [];
        var inputs = ['a', 'aGk*', 'aGk=aGk=', '====', 'abcde'];
        for (var index = 0; index < inputs.length; index += 1) {
          try { atob(inputs[index]); out.push('ok'); }
          catch (error) { out.push(error.name + '|' + error.message); }
        }
        return out;
      })()`,
    )
    assert.equal(errors.length, 5)
    for (const entry of errors) {
      assert.match(entry, /^InvalidCharacterError\|Failed to execute 'atob': The string to be decoded is not correctly encoded\.$/)
    }
    // Three characters plus padding are valid base64, so this one decodes.
    assert.equal(runGuest(harness, `atob('aGk')`), 'hi')
  } finally {
    harness.dispose()
  }
})

test('atob and btoa truncate their traced payloads', async () => {
  const harness = await encodingHarness()
  try {
    const value = runGuest(
      harness,
      `(function () {
        var long = '';
        for (var index = 0; index < 9000; index += 1) long += 'a';
        return btoa(long).length;
      })()`,
    )
    assert.equal(value, 12000)
    const events = harness.trace.events.filter((entry) => entry.kind === 'api' && entry.api === 'btoa')
    assert.equal(events.length, 1)
    assert.equal(events[0].length, 9000, 'the payload length is recorded in full')
    assert.ok(String(events[0].value).length < 9000, 'a 9000-character payload is truncated in the trace')

    runGuest(harness, `atob(btoa('a'.repeat(9000)))`)
    const decoded = harness.trace.events.filter((entry) => entry.kind === 'api' && entry.api === 'atob').at(-1)
    assert.equal(decoded.decodedLength, 9000)
    assert.ok(String(decoded.value).length < 9000, 'the decoded text is truncated too')
  } finally {
    harness.dispose()
  }
})

test('btoa encodes latin1 bytes and rejects code points above 0xff', async () => {
  const harness = await encodingHarness()
  try {
    assert.equal(runGuest(harness, `btoa('hello')`), 'aGVsbG8=')
    assert.equal(runGuest(harness, `btoa('\\u00ff')`), '/w==')
    assert.equal(runGuest(harness, `btoa('')`), '')

    const error = runGuest(
      harness,
      `(function () {
        try { btoa('\\u20ac'); return 'encoded'; }
        catch (thrown) { return thrown.name + '|' + thrown.message; }
      })()`,
    )
    assert.equal(
      error,
      "InvalidCharacterError|Failed to execute 'btoa': The string to be encoded contains characters outside of the Latin1 range.",
    )
  } finally {
    harness.dispose()
  }
})

test('TextEncoder reports utf-8 and encodes to a typed byte array', async () => {
  const harness = await encodingHarness()
  try {
    const value = runGuest(
      harness,
      `(function () {
        var encoder = new TextEncoder();
        var single = encoder.encode('A');
        var multi = encoder.encode('€');
        return JSON.stringify({
          encoding: encoder.encoding,
          constructor: encoder.constructor.name,
          tag: Object.prototype.toString.call(single),
          single: Array.from(single),
          multi: Array.from(multi),
          multiLength: multi.length,
          identity: encoder.encode === encoder.encode,
          length: TextEncoder.length,
        });
      })()`,
    )
    const parsed = JSON.parse(value)
    assert.equal(parsed.encoding, 'utf-8')
    assert.equal(parsed.constructor, 'TextEncoder')
    assert.equal(parsed.tag, '[object Uint8Array]')
    assert.deepEqual(parsed.single, [65])
    assert.deepEqual(parsed.multi, [226, 130, 172])
    assert.equal(parsed.multiLength, 3)
    assert.equal(parsed.identity, true)
    assert.equal(parsed.length, 0)
  } finally {
    harness.dispose()
  }
})

test('TextEncoder.encodeInto reports read and written counts', async () => {
  const harness = await encodingHarness()
  try {
    const value = runGuest(
      harness,
      `(function () {
        var encoder = new TextEncoder();
        var roomy = new Uint8Array(16);
        var tight = new Uint8Array(2);
        var exact = new Uint8Array(4);
        var wide = new Uint8Array(1);
        return JSON.stringify({
          roomy: encoder.encodeInto('héllo', roomy),
          roomyBytes: Array.from(roomy),
          tight: encoder.encodeInto('héllo', tight),
          tightBytes: Array.from(tight),
          exact: encoder.encodeInto('€', exact),
          exactBytes: Array.from(exact),
          wide: encoder.encodeInto('€', wide),
          wideBytes: Array.from(wide),
          missing: encoder.encodeInto('abc'),
        });
      })()`,
    )
    const parsed = JSON.parse(value)
    // "héllo" is 6 UTF-8 bytes: 5 code units, all of them fit in 16 bytes.
    assert.deepEqual(parsed.roomy, { read: 5, written: 6 })
    assert.deepEqual(parsed.roomyBytes.slice(0, 6), [104, 195, 169, 108, 108, 111])
    // A 2-byte destination cuts the multibyte sequence after two bytes.
    assert.deepEqual(parsed.tight, { read: 2, written: 2 })
    assert.deepEqual(parsed.tightBytes, [104, 195])
    assert.deepEqual(parsed.exact, { read: 1, written: 3 })
    assert.deepEqual(parsed.exactBytes.slice(0, 3), [226, 130, 172], 'the decoder writes three bytes and leaves the rest')
    assert.equal(parsed.exactBytes.length, 4)
    assert.deepEqual(parsed.wide, { read: 1, written: 1 }, 'one byte of a three-byte sequence fits')
    assert.deepEqual(parsed.wideBytes, [226])
    assert.deepEqual(parsed.missing, { read: 0, written: 0 })
  } finally {
    harness.dispose()
  }
})

test('TextDecoder decodes every accepted label and its aliases', async () => {
  const harness = await encodingHarness()
  try {
    const value = runGuest(
      harness,
      `(function () {
        var bytes = new Uint8Array([104, 105]);
        var labels = ['utf-8', 'utf8', 'unicode-1-1-utf-8', 'UTF-8'];
        var encodings = labels.map(function (label) { return new TextDecoder(label).encoding });
        return JSON.stringify({
          encodings: encodings,
          text: new TextDecoder().decode(bytes),
          latin1: new TextDecoder('latin1').encoding,
          ascii: new TextDecoder('ascii').encoding,
          utf16: new TextDecoder('utf-16le').encoding,
          utf16Alias: new TextDecoder('utf-16').encoding,
          bom: new TextDecoder('utf-8').decode(new Uint8Array([239, 187, 191, 65])),
          keepBom: new TextDecoder('utf-8', { ignoreBOM: true }).decode(new Uint8Array([239, 187, 191, 65])),
          prototype: TextDecoder.prototype.decode(new Uint8Array([66])),
        });
      })()`,
    )
    const parsed = JSON.parse(value)
    assert.deepEqual(parsed.encodings, ['utf-8', 'utf-8', 'utf-8', 'utf-8'])
    assert.equal(parsed.text, 'hi')
    assert.equal(parsed.latin1, 'windows-1252')
    assert.equal(parsed.ascii, 'windows-1252')
    assert.equal(parsed.utf16, 'utf-16le')
    assert.equal(parsed.utf16Alias, 'utf-16le')
    assert.equal(parsed.bom, 'A', 'a BOM is stripped by default')
    assert.equal(parsed.keepBom, '\ufeffA', 'ignoreBOM keeps the BOM')
    assert.equal(parsed.prototype, 'B')
  } finally {
    harness.dispose()
  }
})

test('TextDecoder rejects unknown labels with a RangeError', async () => {
  const harness = await encodingHarness()
  try {
    const value = runGuest(
      harness,
      `(function () {
        var out = [];
        var labels = ['bogus-encoding', 'no-such-charset'];
        for (var index = 0; index < labels.length; index += 1) {
          try { new TextDecoder(labels[index]); out.push('accepted'); }
          catch (error) { out.push(error.name + '|' + error.message); }
        }
        return out;
      })()`,
    )
    for (const entry of value) {
      assert.match(entry, /^RangeError\|Failed to construct 'TextDecoder': The encoding label provided \('.+'\) is invalid\.$/)
    }
  } finally {
    harness.dispose()
  }
})

test('TextDecoder accepts buffers, views and rejects nothing else', async () => {
  const harness = await encodingHarness()
  try {
    const value = runGuest(
      harness,
      `(function () {
        var decoder = new TextDecoder('utf-8');
        var buffer = new ArrayBuffer(3);
        new Uint8Array(buffer).set([97, 98, 99]);
        return JSON.stringify({
          buffer: decoder.decode(buffer),
          view: decoder.decode(new Uint8Array([100, 101])),
          none: decoder.decode(),
          plain: decoder.decode({}),
          text: decoder.decode('abc'),
          fatal: decoder.fatal,
          ignoreBOM: decoder.ignoreBOM,
          encoding: decoder.encoding,
          length: TextDecoder.length,
        });
      })()`,
    )
    const parsed = JSON.parse(value)
    assert.equal(parsed.buffer, 'abc')
    assert.equal(parsed.view, 'de')
    assert.equal(parsed.none, '')
    assert.equal(parsed.plain, '', 'a non-buffer object decodes to the empty string')
    assert.equal(parsed.text, '', 'a string is not a byte source')
    assert.equal(parsed.fatal, false)
    assert.equal(parsed.ignoreBOM, false)
    assert.equal(parsed.encoding, 'utf-8')
    assert.equal(parsed.length, 2, 'TextDecoder takes (label, options)')
  } finally {
    harness.dispose()
  }
})

test('a fatal decoder throws on malformed input and records the decode', async () => {
  const harness = await encodingHarness()
  try {
    const value = runGuest(
      harness,
      `(function () {
        var strict = new TextDecoder('utf-8', { fatal: true });
        var lenient = new TextDecoder('utf-8');
        var malformed = new Uint8Array([0xff, 0xfe]);
        var out = { lenient: lenient.decode(malformed) };
        try { strict.decode(malformed); out.strict = 'decoded'; }
        catch (error) { out.strict = error.name; }
        out.fatal = strict.fatal;
        return JSON.stringify(out);
      })()`,
    )
    const parsed = JSON.parse(value)
    assert.equal(parsed.strict, 'TypeError', 'the host codec error is re-thrown as a guest TypeError')
    assert.equal(parsed.fatal, true)
    assert.equal(typeof parsed.lenient, 'string')

    // Only the successful decode is recorded: a fatal rejection happens before
    // the trace point, exactly like the summary a browser console would show.
    const events = harness.trace.events.filter((entry) => entry.kind === 'api' && entry.api === 'TextDecoder.decode')
    assert.equal(events.length, 1, JSON.stringify(events))
    assert.equal(events[0].encoding, 'utf-8')
    assert.equal(events[0].length, 2)
  } finally {
    harness.dispose()
  }
})

test('the codecs look native and can be installed standalone', async () => {
  const harness = await createHarness({ modules: ['globals'] })
  try {
    installEncoding(harness.bridge)
    const value = runGuest(
      harness,
      `[String(atob).indexOf('[native code]') > 0,
        String(TextEncoder).indexOf('[native code]') > 0,
        String(TextDecoder.prototype.decode).indexOf('[native code]') > 0,
        atob('YQ==')]`,
    )
    assert.deepEqual(value, [true, true, true, 'a'])
  } finally {
    harness.dispose()
  }
})

import { createSeededRandom, seededPick } from '../util/random.js'

/**
 * Coherent, seeded browser profile.
 *
 * A sandbox that answers `navigator.userAgent` with a Linux UA while
 * `navigator.platform` says `Win32`, or reports `Asia/Shanghai` while
 * `Intl.DateTimeFormat().resolvedOptions().timeZone` says `UTC`, is trivially
 * detected. This module is the single source of truth for every fingerprintable
 * value; environment modules must read from it and never invent their own
 * values. `consistencyReport()` proves the invariants hold.
 */

export const LOCALES = Object.freeze({
  'zh-CN': {
    language: 'zh-CN',
    languages: ['zh-CN', 'zh', 'en'],
    timezone: 'Asia/Shanghai',
    tzOffsetMinutes: -480,
    currency: 'CNY',
    numberingSystem: 'latn',
    dateFormat: '2026/10/19 15:20:00',
  },
  'en-US': {
    language: 'en-US',
    languages: ['en-US', 'en'],
    timezone: 'America/New_York',
    tzOffsetMinutes: 240,
    currency: 'USD',
    numberingSystem: 'latn',
    dateFormat: '10/19/2026, 3:20:00 PM',
  },
  'en-GB': {
    language: 'en-GB',
    languages: ['en-GB', 'en'],
    timezone: 'Europe/London',
    tzOffsetMinutes: -60,
    currency: 'GBP',
    numberingSystem: 'latn',
    dateFormat: '19/10/2026, 15:20:00',
  },
  'ru-RU': {
    language: 'ru-RU',
    languages: ['ru-RU', 'ru'],
    timezone: 'Europe/Moscow',
    tzOffsetMinutes: -180,
    currency: 'RUB',
    numberingSystem: 'latn',
    dateFormat: '19.10.2026, 15:20:00',
  },
  'ja-JP': {
    language: 'ja-JP',
    languages: ['ja-JP', 'ja'],
    timezone: 'Asia/Tokyo',
    tzOffsetMinutes: -540,
    currency: 'JPY',
    numberingSystem: 'latn',
    dateFormat: '2026/10/19 15:20:00',
  },
})

/** Operating-system specific, GA-release-plausible building blocks. */
export const OS_FAMILIES = Object.freeze({
  windows: {
    names: ['Windows NT 10.0; Win64; x64', 'Windows NT 10.0; WOW64', 'Windows NT 10.0; Win64; x64'],
    platform: 'Win32',
    architecture: 'x86',
    bitness: '64',
    platformVersion: '15.0.0',
    fonts: [
      'Arial',
      'Calibri',
      'Cambria',
      'Consolas',
      'Courier New',
      'Georgia',
      'Lucida Console',
      'Microsoft Sans Serif',
      'MS Gothic',
      'Segoe UI',
      'SimSun',
      'Tahoma',
      'Times New Roman',
      'Trebuchet MS',
      'Verdana',
      'Wingdings',
    ],
    gpus: [
      { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 SUPER Direct3D11 vs_5_0 ps_5_0, D3D11)' },
      { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
      { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon RX 580 Series Direct3D11 vs_5_0 ps_5_0, D3D11)' },
    ],
    userAgentToken: 'Windows NT 10.0; Win64; x64',
    oscpu: 'Windows NT 10.0; Win64; x64',
  },
  macos: {
    names: ['Macintosh; Intel Mac OS X 10_15_7', 'Macintosh; Intel Mac OS X 10_15_7'],
    platform: 'MacIntel',
    architecture: 'x86',
    bitness: '64',
    platformVersion: '15.6.1',
    fonts: [
      'American Typewriter',
      'Andale Mono',
      'Arial',
      'Arial Black',
      'Courier',
      'Courier New',
      'Geneva',
      'Georgia',
      'Helvetica',
      'Helvetica Neue',
      'Menlo',
      'Monaco',
      'Optima',
      'PingFang SC',
      'SF Pro Text',
      'Times',
      'Times New Roman',
      'Verdana',
    ],
    gpus: [
      { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)' },
      { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) Iris(TM) Plus Graphics 640, OpenGL 4.1)' },
    ],
    userAgentToken: 'Macintosh; Intel Mac OS X 10_15_7',
    oscpu: 'Intel Mac OS X 10.15',
  },
  linux: {
    names: ['X11; Linux x86_64', 'X11; Ubuntu; Linux x86_64'],
    platform: 'Linux x86_64',
    architecture: 'x86',
    bitness: '64',
    platformVersion: '6.5.0',
    fonts: [
      'DejaVu Sans',
      'DejaVu Sans Mono',
      'DejaVu Serif',
      'Liberation Mono',
      'Liberation Sans',
      'Liberation Serif',
      'Noto Sans',
      'Noto Sans CJK SC',
      'Ubuntu',
    ],
    gpus: [
      { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Mesa Intel(R) UHD Graphics 620 (KBL GT2), OpenGL 4.6)' },
      { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1050/PCIe/SSE2, OpenGL 4.5)' },
    ],
    userAgentToken: 'X11; Linux x86_64',
    oscpu: 'Linux x86_64',
  },
})

export const DEVICES = Object.freeze([
  { width: 1920, height: 1080, dpr: 1, touch: 0 },
  { width: 2560, height: 1440, dpr: 1, touch: 0 },
  { width: 1440, height: 900, dpr: 2, touch: 0 },
  { width: 1536, height: 864, dpr: 1.25, touch: 0 },
  { width: 1366, height: 768, dpr: 1, touch: 0 },
  { width: 412, height: 915, dpr: 2.625, touch: 5 },
])

export const BROWSERS = Object.freeze({
  chrome: {
    name: 'Chrome',
    vendor: 'Google Inc.',
    engine: 'Blink',
    versions: ['128.0.6613.120', '129.0.6668.90', '130.0.6723.92', '131.0.6778.86'],
    productSub: '20030107',
    brands: (major) => [
      { brand: 'Chromium', version: String(major) },
      { brand: 'Google Chrome', version: String(major) },
      { brand: 'Not)A;Brand', version: '99' },
    ],
  },
  edge: {
    name: 'Edge',
    vendor: 'Google Inc.',
    engine: 'Blink',
    versions: ['128.0.2739.79', '129.0.2792.79', '130.0.2849.68'],
    productSub: '20030107',
    brands: (major) => [
      { brand: 'Chromium', version: String(major) },
      { brand: 'Microsoft Edge', version: String(major) },
      { brand: 'Not)A;Brand', version: '99' },
    ],
  },
  firefox: {
    name: 'Firefox',
    vendor: '',
    engine: 'Gecko',
    versions: ['128.0', '129.0.2', '131.0'],
    productSub: '20100101',
    brands: () => [],
  },
})

/** Fixed default epoch: 2026-10-19T07:20:00Z, 15:20 in Asia/Shanghai. */
export const DEFAULT_EPOCH = 1792394400000

/**
 * @param {object} [options]
 * @param {number|string} [options.seed]
 * @param {'windows'|'macos'|'linux'} [options.os]
 * @param {'chrome'|'edge'|'firefox'} [options.browser]
 * @param {string} [options.locale]
 * @param {number} [options.epoch] fixed virtual wall-clock anchor (ms)
 * @param {object} [options.screen] override screen metrics
 * @param {string} [options.userAgent] override UA
 * @param {string} [options.host] page host used by location/document
 * @param {boolean} [options.mobile]
 */
export function createProfile(options = {}) {
  const seed = options.seed ?? 0x5eed
  const rng = createSeededRandom(`${seed}::profile`)
  const osKey = options.os ?? seededPick(Object.keys(OS_FAMILIES), seed, 'os')
  const browserKey = options.browser ?? seededPick(Object.keys(BROWSERS), seed, 'browser')
  const localeKey = options.locale ?? seededPick(Object.keys(LOCALES), seed, 'locale')
  const mobileRequested = options.mobile === true
  const devicePool = mobileRequested ? DEVICES : DEVICES.filter((item) => item.touch === 0)
  const device = options.screen ?? seededPick(devicePool, seed, 'device')

  const os = OS_FAMILIES[osKey]
  const browser = BROWSERS[browserKey]
  const locale = LOCALES[localeKey]
  const version = options.browserVersion ?? browser.versions[Math.floor(rng.next() * browser.versions.length)]
  const major = Number.parseInt(version, 10)
  const osToken = os.names[Math.floor(rng.next() * os.names.length)]
  const gpu = os.gpus[Math.floor(rng.next() * os.gpus.length)]
  const mobile = mobileRequested || device.touch > 0

  const chromeLike = browserKey === 'chrome' || browserKey === 'edge'
  const firefoxLike = browserKey === 'firefox'

  const mobileToken = 'Linux; Android 13; Pixel 7'
  const effectiveToken = mobile && chromeLike ? mobileToken : osToken
  const ua = firefoxLike
    ? `Mozilla/5.0 (${effectiveToken}; rv:${major}.0) Gecko/20100101 Firefox/${version}`
    : browserKey === 'edge'
      ? `Mozilla/5.0 (${effectiveToken}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Mobile Safari/537.36 Edg/${version}`
      : mobile
        ? `Mozilla/5.0 (${effectiveToken}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Mobile Safari/537.36`
        : `Mozilla/5.0 (${effectiveToken}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`

  const userAgent = options.userAgent ?? ua
  const host = options.host ?? 'www.example-cdn.com'
  const nowEpoch = options.epoch ?? DEFAULT_EPOCH
  const localTime = new Date(nowEpoch + locale.tzOffsetMinutes * -60_000)

  const screen = {
    width: device.width,
    height: device.height,
    availWidth: device.width,
    availHeight: device.height - (osKey === 'macos' ? 25 : 40),
    colorDepth: 24,
    pixelDepth: 24,
    devicePixelRatio: device.dpr,
  }

  const innerWidth = screen.width
  const innerHeight = screen.availHeight - (mobile ? 0 : 88)
  const outerWidth = screen.availWidth
  const outerHeight = screen.availHeight

  const plugins = firefoxLike
    ? [
        { name: 'PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'Microsoft Edge PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'WebKit built-in PDF', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
      ]
    : [
        { name: 'PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'Microsoft Edge PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'WebKit built-in PDF', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
      ]

  const fonts = [...new Set([...os.fonts, 'Arial', 'Courier New', 'Georgia', 'Times New Roman', 'Verdana'])]

  return {
    seed: String(seed),
    os: osKey,
    osName: osKey === 'windows' ? 'Windows 10' : osKey === 'macos' ? 'macOS 15' : 'Linux',
    browser: browserKey,
    browserName: browser.name,
    browserVersion: version,
    browserMajor: major,
    engine: browser.engine,
    vendor: browser.vendor,
    productSub: browser.productSub,
    mobile,
    userAgent,
    appVersion: userAgent.replace(/^Mozilla\//, ''),
    appName: 'Netscape',
    appCodeName: 'Mozilla',
    product: 'Gecko',
    platform: mobile && chromeLike ? 'Linux armv8l' : os.platform,
    oscpu: os.oscpu,
    architecture: os.architecture,
    bitness: os.bitness,
    platformVersion: os.platformVersion,
    buildID: firefoxLike ? '20241014105822' : undefined,
    language: locale.language,
    languages: locale.languages,
    timezone: locale.timezone,
    /** JS `Date#getTimezoneOffset()` sign convention (minutes behind UTC). */
    timezoneOffsetMinutes: locale.tzOffsetMinutes,
    currency: locale.currency,
    numberingSystem: locale.numberingSystem,
    localeDateFormat: locale.dateFormat,
    // Chrome/Firefox expose document.lastModified as MM/DD/YYYY HH:mm:ss in the
    // page's local time, independent of locale formatting.
    lastModified: (() => {
      const local = new Date(nowEpoch - locale.tzOffsetMinutes * 60_000)
      const pad = (value) => String(value).padStart(2, '0')
      return (
        `${pad(local.getUTCMonth() + 1)}/${pad(local.getUTCDate())}/${local.getUTCFullYear()} ` +
        `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}`
      )
    })(),
    epoch: nowEpoch,
    localTime: localTime.toISOString(),
    screen,
    window: { innerWidth, innerHeight, outerWidth, outerHeight, screenX: 0, screenY: osKey === 'macos' ? 25 : 0, scrollX: 0, scrollY: 0 },
    hardwareConcurrency: [4, 8, 12, 16][Math.floor(rng.next() * 4)],
    deviceMemory: [4, 8, 8, 16][Math.floor(rng.next() * 4)],
    maxTouchPoints: device.touch,
    doNotTrack: null,
    cookieEnabled: true,
    onLine: true,
    pdfViewerEnabled: true,
    webdriver: false,
    plugins,
    fonts,
    webgl: {
      vendor: gpu.vendor,
      renderer: gpu.renderer,
      version: 'WebGL 1.0 (OpenGL ES 2.0 Chromium)',
      shadingLanguageVersion: 'WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)',
      maxTextureSize: 16384,
      maxViewportDims: [16384, 16384],
      maxRenderbufferSize: 16384,
      aliasedLineWidthRange: [1, 1],
      aliasedPointSizeRange: [1, 1024],
    },
    audio: {
      sampleRate: firefoxLike ? 48000 : 44100,
      maxChannelCount: 2,
      fingerprintNoise: rng.hex(12),
    },
    canvas: { noise: rng.hex(16), seed: rng.hex(8) },
    battery: (() => {
      const charging = rng.next() > 0.3
      return {
        charging,
        level: 0.63 + rng.next() * 0.3,
        chargingTime: charging ? 0 : Infinity,
        dischargingTime: charging ? Infinity : 12_000,
      }
    })(),
    connection: {
      effectiveType: '4g',
      rtt: 50,
      downlink: 10,
      saveData: false,
      type: undefined,
    },
    chrome: chromeLike
      ? {
          runtime: {},
          app: { isInstalled: false },
          csi: () => ({ onloadT: 0, startE: nowEpoch, pageT: 0, tran: 15 }),
          loadTimes: () => ({}),
        }
      : undefined,
    userAgentData: chromeLike
      ? {
          brands: browser.brands(major),
          mobile,
          platform: osKey === 'windows' ? 'Windows' : osKey === 'macos' ? 'macOS' : 'Linux',
          getHighEntropyValues: {
            architecture: os.architecture,
            bitness: os.bitness,
            model: '',
            platformVersion: os.platformVersion,
            uaFullVersion: version,
            fullVersionList: browser.brands(major).map((entry) => ({ ...entry, version })),
          },
        }
      : undefined,
    permissions: {
      notifications: 'default',
      geolocation: 'prompt',
      camera: 'prompt',
      microphone: 'prompt',
      'clipboard-read': 'prompt',
      'clipboard-write': 'granted',
      persistentStorage: 'prompt',
    },
    storage: {
      quota: 299_977_883_648,
      usage: 0,
      localStoragePrefix: `ai4r:${rng.hex(6)}:`,
    },
    referrer: '',
    host,
    origin: `https://${host}`,
    href: `https://${host}/`,
    mediaDevices: [
      {
        kind: 'audioinput',
        label:
          osKey === 'windows'
            ? 'Default - Microphone (Realtek(R) Audio)'
            : osKey === 'macos'
              ? 'Default - MacBook Pro Microphone'
              : 'Default - Built-in Audio Analog Stereo',
        deviceId: rng.hex(16),
      },
      {
        kind: 'audiooutput',
        label:
          osKey === 'windows'
            ? 'Default - Speakers (Realtek(R) Audio)'
            : osKey === 'macos'
              ? 'Default - MacBook Pro Speakers'
              : 'Default - Built-in Audio Analog Stereo',
        deviceId: rng.hex(16),
      },
      {
        kind: 'videoinput',
        label: osKey === 'macos' ? 'FaceTime HD Camera' : osKey === 'linux' ? 'Integrated Webcam' : 'Integrated Camera',
        deviceId: rng.hex(16),
      },
    ],
    hasFocus: true,
    visibilityState: 'visible',
    hidden: false,
    historyLength: 1,
    notificationPermission: 'default',
    serviceWorkerSupported: true,
    webAssemblySupported: true,
    rtcSupported: true,
    speechSupported: true,
    offscreenCanvasSupported: chromeLike,
    sharedArrayBufferSupported: chromeLike,
    resizableArrayBufferSupported: chromeLike,
  }
}

/**
 * Verify the profile is internally coherent. Used by tests and exposed through
 * the sandbox report so an analyst can prove the environment was consistent.
 * @param {ReturnType<typeof createProfile>} profile
 */
export function consistencyReport(profile) {
  const problems = []
  const ua = profile.userAgent

  const uaPlatformToken =
    profile.os === 'windows' ? 'Windows NT' : profile.os === 'macos' ? 'Macintosh' : 'Linux'
  if (!ua.includes(uaPlatformToken)) problems.push(`UA missing platform token ${uaPlatformToken}`)

  if (profile.os === 'windows' && profile.platform !== 'Win32') problems.push('Windows profile must report Win32')
  if (profile.os === 'macos' && profile.platform !== 'MacIntel') problems.push('macOS profile must report MacIntel')
  if (profile.os === 'linux' && !profile.platform.startsWith('Linux')) problems.push('Linux profile must report Linux platform')
  if (profile.mobile && !/Mobile|Android|iPhone/.test(profile.userAgent)) problems.push('mobile profile needs a Mobile UA token')

  const locale = LOCALES[profile.language]
  if (locale) {
    if (locale.timezone !== profile.timezone) problems.push('timezone does not match locale preset')
    if (locale.tzOffsetMinutes !== profile.timezoneOffsetMinutes) problems.push('timezone offset does not match locale preset')
  } else {
    problems.push(`unknown locale ${profile.language}`)
  }

  if (profile.webgl.renderer.includes('Direct3D') && profile.os !== 'windows') problems.push('D3D renderer on non-Windows profile')
  if (profile.webgl.renderer.includes('Metal') && profile.os !== 'macos') problems.push('Metal renderer on non-macOS profile')
  if (profile.webgl.renderer.includes('Mesa') && profile.os !== 'linux') problems.push('Mesa renderer on non-Linux profile')

  if (profile.browser === 'firefox' && profile.userAgentData) problems.push('Firefox must not expose userAgentData')
  if ((profile.browser === 'chrome' || profile.browser === 'edge') && !profile.userAgentData) {
    problems.push('Chromium profile must expose userAgentData')
  }
  if (profile.browser === 'firefox' && profile.chrome) problems.push('Firefox must not expose window.chrome')

  if (profile.screen.availWidth > profile.screen.width) problems.push('availWidth cannot exceed width')
  if (profile.screen.devicePixelRatio <= 0) problems.push('devicePixelRatio must be positive')
  if (profile.timezoneOffsetMinutes > 840 || profile.timezoneOffsetMinutes < -840) {
    problems.push('timezone offset out of range')
  }
  return { ok: problems.length === 0, problems, checked: 12 }
}

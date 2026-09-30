/**
 * Offline test for dsh-custom-background.
 *
 * Covers the parts that decide what the page receives: configuration clamping, local-path
 * resolution, the generated CSS (wallpaper layer, selector shape, light/dark pair, glass
 * scaling) and the host `apply` contract — the two boot rows and the image route.
 *
 * What it cannot cover: pixels, and the actual load of the browser bundle. Those need a
 * running GUI.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  CSS_ROUTE,
  Config,
  DEFAULTS,
  GLASS_TOKENS,
  GLOBAL_NAME,
  ROUTE_PATH,
  STYLE_ID,
  apply,
  buildCss,
  glassAlpha,
  isRemoteImage,
  imageVersion,
  normalizeConfig,
  resolveImagePath,
  resolveImageUrl,
} from '../lib/index.js'

let failures = 0
/** Run one named check, reporting instead of aborting the file. Async checks are awaited. */
const check = (name, run) => {
  const report = (error) => {
    failures += 1
    console.log(`FAIL ${name}\n     ${String(error).split('\n').join('\n     ')}`)
  }
  let result
  try {
    result = run()
  } catch (error) {
    report(error)
    return undefined
  }
  if (result !== null && typeof result?.then === 'function') {
    return result.then(() => { console.log(`ok   ${name}`) }, report)
  }
  console.log(`ok   ${name}`)
  return undefined
}

/** Minimal node:http response stand-in: records what a route handler wrote. */
function fakeResponse() {
  return {
    status: 0,
    headers: null,
    body: undefined,
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    end(body) {
      this.body = body
    },
  }
}

/** Minimal cordis context stand-in: records injections, effects, rows and routes. */
function fakeContext() {
  const injections = []
  const rows = []
  const routes = []
  return {
    rows,
    routes,
    injections,
    logger: { warn: () => {} },
    on: (event, listener) => { if (event === 'webserver/index-inject') injections.push(listener) },
    inject: (services, callback) => {
      assert.deepEqual(services, ['webServer'])
      callback({
        effect: (run, label) => { assert.equal(typeof label, 'string'); run() },
        webServer: { register: (route) => { routes.push(route); return () => {} } },
      })
    },
  }
}

const remote = normalizeConfig({ enabled: true, image: 'https://example.test/bg.jpg' })

/**
 * Mirror of `@deepseek-ai/dsh-settings`' own `volatileForm`: a plugin entry reaches the
 * Plugins page's configuration form only when one of its fields is volatile, and it is copied
 * here so a schema that loses `.volatile()` fails this suite instead of failing in the GUI.
 */
function volatileForm(schema) {
  if (schema.meta.volatile === true) return true
  if (schema.type === 'object') {
    const dict = Object.fromEntries(Object.entries(schema.dict ?? {}).flatMap(([key, child]) => {
      const field = volatileForm(child)
      return field === undefined ? [] : [[key, field]]
    }))
    return Object.keys(dict).length === 0 ? undefined : dict
  }
  return undefined
}

check('manifest: dsh.client declares the web platform with a boolean flag', () => {
  const root = dirname(dirname(fileURLToPath(import.meta.url)))
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  assert.equal(pkg.dsh.manifestVersion, 1)
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.equal(typeof pkg.dsh.client.immediately, 'boolean')
  assert.equal(pkg.exports['./client'], './client.js')
  assert.equal(pkg.main, 'lib/index.js')
  assert.deepEqual(Object.keys(pkg.dependencies), ['@deepseek-ai/schemastery'], 'the host half owns exactly one runtime dependency')
})

check('config schema: the row is editable only because this schema exists', () => {
  // The real path: the loader hands `apply` the schema's own output, which wraps every volatile
  // field in an accessor — so this asserts the pair (schema out, normalizeConfig in) together.
  assert.deepEqual(normalizeConfig(Config({})), { ...DEFAULTS })
  const given = normalizeConfig(Config({ enabled: true, image: 'D:/x.png', blur: 24, glass: 0.5 }))
  assert.deepEqual(given, { ...DEFAULTS, enabled: true, image: 'D:/x.png', blur: 24, glass: 0.5 })
  assert.throws(() => Config({ blur: 200 }))
  assert.throws(() => Config({ enabled: 'yes' }))
  // The schema's keys and the form's fields are the same set, by construction.
  assert.deepEqual(Object.keys(DEFAULTS).sort(), ['blur', 'dim', 'enabled', 'glass', 'image', 'panels', 'saturation'])
})

check('config: a volatile accessor is read through get(), plain values pass through', () => {
  const accessor = (value) => ({ get: () => value })
  assert.deepEqual(
    normalizeConfig({
      enabled: accessor(true),
      image: accessor('  D:/x.png  '),
      blur: accessor(30),
      dim: accessor(0.4),
      saturation: accessor(0.5),
      glass: accessor(0.25),
      panels: accessor('solid'),
    }),
    { enabled: true, image: 'D:/x.png', blur: 30, dim: 0.4, saturation: 0.5, glass: 0.25, panels: 'solid' },
  )
  // A live write is visible on the next read, which is the point of the accessor.
  let live = 18
  const subject = { blur: { get: () => live } }
  assert.equal(normalizeConfig(subject).blur, 18)
  live = 42
  assert.equal(normalizeConfig(subject).blur, 42)
})

check('config schema: every field is volatile, or the Plugins page skips the whole entry', () => {
  const form = volatileForm(Config)
  assert.notEqual(form, undefined, 'no volatile field means no descriptor and no Configure page')
  assert.deepEqual(Object.keys(form).sort(), Object.keys(DEFAULTS).sort())
  for (const [key, field] of Object.entries(Config.dict)) {
    assert.equal(field.meta.volatile, true, `${key} must be volatile for a write to be accepted`)
  }
})

check('config: defaults and clamping', () => {
  const empty = normalizeConfig(undefined)
  assert.deepEqual(empty, { ...DEFAULTS })
  assert.equal(empty.enabled, false)
  const wild = normalizeConfig({ enabled: 'true', blur: 999, dim: -3, saturation: 42, glass: 5 })
  assert.equal(wild.enabled, true)
  assert.equal(wild.blur, 80)
  assert.equal(wild.dim, 0)
  assert.equal(wild.saturation, 3)
  assert.equal(wild.glass, 1)
  const junk = normalizeConfig({ blur: 'wide', dim: null })
  assert.equal(junk.blur, DEFAULTS.blur)
  assert.equal(junk.dim, DEFAULTS.dim)
})

check('image: scheme URLs are remote, filesystem paths are not', () => {
  for (const value of ['https://x/y.png', 'data:image/png;base64,AA', 'blob:null/1']) {
    assert.equal(isRemoteImage(value), true, value)
    assert.equal(resolveImagePath(value), null, value)
  }
  // A leading `/` is a filesystem path on Linux and macOS, not a URL. Treating it as a URL is
  // the regression this asserts: it made every POSIX absolute path silently paint nothing.
  assert.equal(isRemoteImage('/home/me/bg.png'), false, 'a POSIX absolute path must not read as a URL')
  assert.equal(resolveImagePath('/home/me/definitely-absent-3a7f.png'), null)
  // A leading `/` that names no file stays a path the application already serves.
  assert.equal(resolveImageUrl(normalizeConfig({ image: '/assets/x.png' })), '/assets/x.png')
  assert.equal(isRemoteImage('D:\\pictures\\bg.jpg'), false)
  assert.equal(resolveImagePath('D:\\does\\not\\exist-9f2a.jpg'), null)

  const directory = mkdtempSync(join(tmpdir(), 'dsh-custom-background-'))
  try {
    // `tmpdir()` is the platform's own absolute form: `C:\…` on Windows, `/tmp/…` on POSIX —
    // which is exactly why this case fails on Linux if a leading slash is treated as a URL.
    const file = join(directory, 'bg.png')
    writeFileSync(file, 'not really a png')
    assert.equal(resolveImagePath(file), file)
    assert.ok(resolveImageUrl(normalizeConfig({ image: file })).startsWith(`${ROUTE_PATH}?v=`))

    // A `file:` URL names the same local file; this is how a path copied out of a browser looks.
    const asUrl = `file:///${file.replaceAll('\\', '/')}`
    assert.equal(resolveImagePath(asUrl), file, asUrl)
    // The percent-escaped form of a path with a space resolves too.
    const spaced = join(directory, 'my wallpaper.png')
    writeFileSync(spaced, 'not really a png')
    assert.equal(resolveImagePath(`file:///${spaced.replaceAll('\\', '/').replace(' ', '%20')}`), spaced)

    assert.equal(resolveImagePath(`file:///${file.replaceAll('\\', '/')}.missing`), null)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

check('image url: a local file is addressed by identity, so a swap changes the URL', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-custom-background-'))
  try {
    const first = join(directory, 'a.png')
    const second = join(directory, 'b.png')
    writeFileSync(first, 'first')
    writeFileSync(second, 'second')
    const urlOf = (image) => resolveImageUrl(normalizeConfig({ image }))

    const urlFirst = urlOf(first)
    assert.ok(urlFirst.startsWith(`${ROUTE_PATH}?v=`), urlFirst)
    assert.equal(urlOf(first), urlFirst, 'an unchanged file keeps its URL')
    assert.notEqual(urlOf(second), urlFirst, 'a different path is a different URL')

    // Replacing the file in place must also read as a change: that is what lets the browser
    // re-fetch without a page reload.
    writeFileSync(first, 'first but longer')
    assert.notEqual(urlOf(first), urlFirst)

    // A remote image keeps its own URL; a path that names nothing is nothing to paint. The
    // absent case is Windows-shaped on purpose: a POSIX-absolute absent path is by design
    // indistinguishable from a served path, so it is asserted in the check above instead.
    assert.equal(resolveImageUrl(normalizeConfig({ image: 'https://example.test/bg.jpg' })), 'https://example.test/bg.jpg')
    assert.equal(resolveImageUrl(normalizeConfig({ image: '' })), null)
    assert.equal(resolveImageUrl(normalizeConfig({ image: 'D:\\absent-9f2a\\bg.png' })), null)
    assert.equal(imageVersion(join(directory, 'absent.png')), 'missing')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

check('css: wallpaper layer sits behind content and never covers it', () => {
  const css = buildCss(remote, 'https://example.test/bg.jpg')
  assert.match(css, /html body::before\s*\{/)
  assert.match(css, /position:\s*fixed/)
  assert.match(css, /z-index:\s*-1/)
  assert.match(css, /pointer-events:\s*none/)
  assert.match(css, /filter:\s*blur\(var\(--dsh-custom-background-blur\)\)/)
  assert.match(css, /url\("https:\/\/example\.test\/bg\.jpg"\)/)
})

check('css: selectors outrank the palette rules, both schemes covered', () => {
  const css = buildCss(remote, 'https://example.test/bg.jpg')
  assert.match(css, /html body \{/)
  assert.match(css, /html body\[data-ds-dark-theme\] \{/)
  for (const [token] of GLASS_TOKENS) {
    assert.ok(css.includes(`${token}:`), `missing light override for ${token}`)
  }
  const darkBlock = css.slice(css.indexOf('html body[data-ds-dark-theme]'))
  for (const [token] of GLASS_TOKENS) {
    assert.ok(darkBlock.includes(`${token}:`), `missing dark override for ${token}`)
  }
  assert.equal(css.includes('!important'), false)
})

check('css: glass moves each surface toward its floor, and never below it', () => {
  const at = (glass) => buildCss({ ...remote, glass }, 'https://example.test/bg.jpg')
  const full = at(1)
  const half = at(0.5)
  const solid = at(0)
  assert.ok(full.includes('--dsw-alias-bg-base: color-mix(in srgb, var(--dsw-static-neutral-bluish-00) 52%, transparent)'))
  assert.ok(half.includes('41%'), 'the canvas sits half way to its floor')
  assert.ok(solid.includes('30%'), 'the canvas stops at its floor')
  assert.ok(solid.includes('80%'), 'a text-bearing panel keeps its readability floor')
  assert.equal(solid.includes(' 0%'), false, 'no surface may reach full transparency')
})

check('panels: solid leaves every content surface at its stock fill', () => {
  const glassPanels = buildCss({ ...remote, panels: 'glass' }, 'https://example.test/bg.jpg')
  const solidPanels = buildCss({ ...remote, panels: 'solid' }, 'https://example.test/bg.jpg')

  assert.ok(glassPanels.includes('--dsw-alias-bg-layer-2:'), 'the default still treats panels')
  assert.ok(glassPanels.includes('--dsw-alias-bg-module-platform:'))

  // The picture keeps its own surfaces...
  assert.ok(solidPanels.includes('--dsw-alias-bg-base: color-mix('), 'the canvas stays glassy')
  assert.ok(solidPanels.includes('--dsw-specific-sidebar-fill: color-mix('), 'the sidebar stays glassy')
  // ...and nothing that carries text is repainted, so the wallpaper cannot sit behind it.
  for (const [token, , , , , group] of GLASS_TOKENS) {
    if (group !== 'panels') continue
    assert.equal(solidPanels.includes(`${token}:`), false, `${token} must be untouched under panels: solid`)
  }
  assert.ok(solidPanels.includes('html body::before'), 'the wallpaper itself is still painted')

  // The mode is part of the config surface, and an unknown value falls back to the default.
  assert.equal(normalizeConfig({ panels: 'solid' }).panels, 'solid')
  assert.equal(normalizeConfig({ panels: 'nonsense' }).panels, DEFAULTS.panels)
  assert.equal(normalizeConfig({}).panels, 'glass')
})

check('glass: the ladder reads canvas < chrome < text carriers at every strength', () => {
  const alphaOf = (token, glass) => {
    const row = GLASS_TOKENS.find((entry) => entry[0] === token)
    return glassAlpha(row[3], row[4], glass)
  }
  for (const glass of [0, 0.25, 0.5, 1]) {
    assert.ok(alphaOf('--dsw-alias-bg-base', glass) < alphaOf('--dsw-specific-sidebar-fill', glass), `canvas < sidebar at glass ${glass}`)
    assert.ok(alphaOf('--dsw-specific-sidebar-fill', glass) < alphaOf('--dsw-alias-bg-layer-1', glass), `sidebar < card at glass ${glass}`)
    assert.ok(alphaOf('--dsw-alias-bg-layer-2', glass) >= 0.8, `the settings panel stays readable at glass ${glass}`)
  }
})

check('css: a quoted image value cannot break out of url() or the style element', () => {
  const css = buildCss(remote, 'https://example.test/a").png')
  assert.ok(css.includes('url("https://example.test/a%22).png")'))
  const hostile = buildCss(remote, 'https://example.test/x</style><script>alert(1)</script>')
  assert.equal(hostile.includes('</style'), false)
  assert.equal(hostile.includes('<script'), false)
})

check('apply: publishes a boot global row and a head style row, plus both routes', () => {
  const ctx = fakeContext()
  apply(ctx, { enabled: true, image: 'https://example.test/bg.jpg' })
  assert.equal(ctx.injections.length, 1)
  const table = []
  ctx.injections[0](table)
  assert.equal(table.length, 2)
  const [global, style] = table
  assert.equal(global.kind, 'global')
  assert.equal(global.name, GLOBAL_NAME)
  assert.equal(global.value.enabled, true)
  assert.equal(global.value.css, buildCss(remote, 'https://example.test/bg.jpg'))
  assert.equal(style.kind, 'html')
  assert.equal(style.placement, 'head')
  assert.ok(style.html.startsWith(`<style id="${STYLE_ID}">`))
  assert.ok(style.html.endsWith('</style>'))
  assert.equal(global.value.css.includes('</style'), false)
  assert.equal(style.html.length, global.value.css.length + `<style id="${STYLE_ID}"></style>`.length)

  // Both routes are registered whatever the config says: the settings page must be able to
  // switch the feature on, or point it at an image, without a restart.
  assert.deepEqual(ctx.routes.map((route) => route.path), [CSS_ROUTE, ROUTE_PATH])
  for (const route of ctx.routes) assert.equal(route.kind, 'exact')
})

check('apply: a disabled or image-less config paints nothing and answers 404', () => {
  const cases = [
    undefined,
    {},
    { enabled: false },
    { enabled: true },
    { enabled: true, image: 'D:/definitely/absent-4f1c.png' },
  ]
  for (const config of cases) {
    const ctx = fakeContext()
    apply(ctx, config)
    const table = []
    ctx.injections[0](table)
    assert.deepEqual(table, [], `no rows for ${JSON.stringify(config)}`)
    const css = fakeResponse()
    ctx.routes.find((route) => route.path === CSS_ROUTE).handler({ method: 'GET' }, css)
    assert.equal(css.status, 404, `stylesheet route must answer 404 for ${JSON.stringify(config)}`)
  }
})

await check('apply: a local image is served, and its URL is the plugin route', async () => {  const directory = mkdtempSync(join(tmpdir(), 'dsh-custom-background-'))
  try {
    const file = join(directory, 'bg.png')
    writeFileSync(file, 'not really a png')
    const ctx = fakeContext()
    apply(ctx, { enabled: true, image: file })
    const table = []
    ctx.injections[0](table)
    assert.ok(table[0].value.css.includes(`url("${ROUTE_PATH}?v=`), 'the stylesheet must address the versioned route')

    const image = fakeResponse()
    await ctx.routes.find((route) => route.path === ROUTE_PATH).handler({ method: 'GET' }, image)
    assert.equal(image.status, 200)
    assert.equal(image.headers['content-type'], 'image/png')
    assert.equal(image.body.toString(), 'not really a png')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

await check('apply: the image is re-read per request, so replacing the file needs no restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-custom-background-'))
  try {
    const file = join(directory, 'bg.png')
    writeFileSync(file, 'first')
    const ctx = fakeContext()
    apply(ctx, { enabled: true, image: file })
    const route = ctx.routes.find((row) => row.path === ROUTE_PATH)
    const before = fakeResponse()
    await route.handler({ method: 'GET' }, before)
    assert.equal(before.body.toString(), 'first')
    writeFileSync(file, 'second')
    const after = fakeResponse()
    await route.handler({ method: 'GET' }, after)
    assert.equal(after.body.toString(), 'second')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

check('apply: a live config read is visible on the next use, without remounting', () => {
  // The shape the loader hands `apply` for `.volatile()` fields: accessors, not values. Reading
  // the config once at apply time is the bug this guards against — a saved parameter would keep
  // serving the boot value until the app restarted.
  const store = { enabled: true, image: 'https://example.test/bg.jpg', blur: 18, dim: 0.25, saturation: 1.05, glass: 1 }
  const liveConfig = Object.fromEntries(Object.entries(store).map(([key]) => [key, { get: () => store[key] }]))

  const ctx = fakeContext()
  apply(ctx, liveConfig)

  const first = []
  ctx.injections[0](first)
  assert.ok(first[0].value.css.includes('--dsh-custom-background-blur: 18px'), 'boot value must be served')

  // The user moves two sliders in the settings page.
  store.blur = 60
  store.glass = 0.5

  const second = []
  ctx.injections[0](second)
  assert.ok(second[0].value.css.includes('--dsh-custom-background-blur: 60px'), 'live blur must be read')
  assert.ok(second[0].value.css.includes('41%'), 'live glass strength must be read (52% → 30% floor, half way)')

  const css = fakeResponse()
  ctx.routes.find((route) => route.path === CSS_ROUTE).handler({ method: 'GET' }, css)
  assert.equal(css.status, 200)
  assert.ok(css.body.includes('--dsh-custom-background-blur: 60px'), 'the route must re-read too')

  // Turning the feature off live must stop painting, not keep the last stylesheet.
  store.enabled = false
  const third = []
  ctx.injections[0](third)
  assert.deepEqual(third, [])
  const off = fakeResponse()
  ctx.routes.find((route) => route.path === CSS_ROUTE).handler({ method: 'GET' }, off)
  assert.equal(off.status, 404)
})

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)

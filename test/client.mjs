/**
 * Offline test for the browser half.
 *
 * Loads `client.js` through a stand-in for `window.__ModuleLoader__`, drives `apply` against
 * DOM, slot, locale and `fetch` stand-ins, and renders the configuration entry with real React.
 * It covers the two things this half owns — the stylesheet it takes ownership of, and the
 * operations a save writes — but not pixels or the live write round-trip, which need a running
 * GUI.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

let failures = 0
const check = (name, run) => {
  try {
    run()
    console.log(`ok   ${name}`)
  } catch (error) {
    failures += 1
    console.log(`FAIL ${name}\n     ${String(error).split('\n').join('\n     ')}`)
  }
}
const checkAsync = async (name, run) => {
  try {
    await run()
    console.log(`ok   ${name}`)
  } catch (error) {
    failures += 1
    console.log(`FAIL ${name}\n     ${String(error).split('\n').join('\n     ')}`)
  }
}

/** Minimal element stand-in: identity, dataset, text, and parent-linked removal. */
class FakeElement {
  constructor(tagName) {
    this.tagName = tagName
    this.id = ''
    this.dataset = {}
    this.textContent = ''
    this.parent = null
  }

  remove() {
    if (this.parent === null) return
    this.parent.children = this.parent.children.filter((child) => child !== this)
    this.parent = null
  }
}

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const css = '/* generated */\nhtml body::before { content: ""; }\n'

/** `fetch` stand-in; each check replaces it. Rejecting by default keeps a stray call visible. */
let fetchImpl = () => Promise.reject(new Error('fetch stub not installed'))

/** Fresh DOM stub; returns the head. */
function installDom() {
  const head = new FakeElement('head')
  head.children = []
  const byId = new Map()
  head.append = (element) => {
    element.parent = head
    head.children.push(element)
    if (element.id !== '') byId.set(element.id, element)
  }
  globalThis.document = {
    head,
    // A removed element is unreachable, exactly as a real DOM behaves.
    getElementById: (id) => {
      const element = byId.get(id)
      return element !== undefined && element.parent !== null ? element : null
    },
    querySelector: (selector) =>
      head.children.find(
        (element) =>
          selector === 'style[data-plugin-css="dsh-custom-background/background.css"]' &&
          element.tagName === 'style' &&
          element.dataset.pluginCss === 'dsh-custom-background/background.css',
      ) ?? null,
    createElement: (tagName) => new FakeElement(tagName),
  }
  globalThis.fetch = (url, options) => fetchImpl(url, options)
  return { head }
}

/** Install a boot element the way the host's head row would. */
function installBoot(head) {
  const boot = new FakeElement('style')
  boot.id = 'dsh-custom-background-boot'
  boot.textContent = css
  head.append(boot)
  return boot
}

/** Let the fetch fallback's promise chain run to completion. */
const settle = () => new Promise((resolve) => setImmediate(resolve))

const stylesIn = (head) => head.children.filter((element) => element.tagName === 'style')
const h = React.createElement

/** Active locale for the stub translator; the check that switches it restores it. */
let active = 'zh'

/** Client context stand-in that records the slot registration and the dictionaries. */
function pluginContext() {
  const dictionaries = {}
  const registrations = []
  const injected = []
  return {
    dictionaries,
    registrations,
    injected,
    effect: (run) => { run() },
    inject: (services, callback) => {
      injected.push(services)
      callback({
        effect: (run) => { run() },
        locale: {
          register: (ns, locale, dict) => { dictionaries[`${ns}:${locale}`] = dict },
          bind: (ns) => (key) => dictionaries[`${ns}:${active}`]?.[key] ?? key,
        },
        slots: {
          inject: (name, register) => { assert.equal(name, 'plugins.row.config'); register() },
          register: (options, Component) => { registrations.push({ options, Component }) },
        },
      })
    },
  }
}

/** Client context stand-in for the wallpaper checks: effects only, no form services. */
function wallpaperContext() {
  const disposers = []
  return {
    disposers,
    effect: (run) => {
      const disposer = run()
      if (typeof disposer === 'function') disposers.push(disposer)
    },
    inject: () => {},
  }
}

let loaded
globalThis.window = { __ModuleLoader__: { load: (entry) => { loaded = entry } } }
await import('../client.js')

const plugin = loaded.factory((id) => {
  if (id === 'react') return React
  throw new Error(`unexpected require(${id})`)
})
const test = plugin.__test

check('manifest: one entry, keyed by package name, no inject list', () => {
  assert.equal(loaded.id, 'dsh-custom-background')
  assert.equal(typeof plugin.apply, 'function')
  assert.equal(plugin.inject, undefined, 'the wallpaper must not wait on the theme or slot service')
})

check('apply: replaces the boot stylesheet with a plugin-owned copy', () => {
  const { head } = installDom()
  const boot = installBoot(head)
  globalThis.__DSH_CUSTOM_BACKGROUND__ = { enabled: true, css }
  const ctx = wallpaperContext()
  plugin.apply(ctx)

  assert.equal(document.getElementById('dsh-custom-background-boot'), null, 'boot element must be removed')
  assert.equal(boot.parent, null)
  assert.equal(stylesIn(head).length, 1)
  assert.equal(stylesIn(head)[0].dataset.plugin, 'dsh-custom-background')
  assert.equal(stylesIn(head)[0].dataset.pluginCss, 'dsh-custom-background/background.css')
  assert.equal(stylesIn(head)[0].textContent, css)

  ctx.disposers.forEach((dispose) => dispose())
  assert.equal(head.children.length, 0, 'unload must take the stylesheet away')
})

check('apply: a hot reload does not stack stylesheets', () => {
  const { head } = installDom()
  installBoot(head)
  globalThis.__DSH_CUSTOM_BACKGROUND__ = { enabled: true, css }
  plugin.apply(wallpaperContext())
  plugin.apply(wallpaperContext())
  assert.equal(stylesIn(head).length, 1)
})

check('apply: publishes nothing without an enabled payload', () => {
  for (const payload of [undefined, null, {}, { enabled: false, css }, { enabled: true }, { enabled: true, css: 42 }]) {
    const { head } = installDom()
    const boot = installBoot(head)
    globalThis.__DSH_CUSTOM_BACKGROUND__ = payload
    // The fiber cleanup is registered unconditionally; it just has nothing to remove here.
    plugin.apply(wallpaperContext())
    assert.equal(stylesIn(head).length, 0)
    assert.equal(boot.parent, null, 'the boot copy is still replaced so the page never keeps two')
  }
})

await checkAsync('apply: falls back to the host stylesheet route when no boot payload exists', async () => {
  const { head } = installDom()
  installBoot(head)
  globalThis.__DSH_CUSTOM_BACKGROUND__ = undefined
  const calls = []
  fetchImpl = (url, options) => {
    calls.push({ url, options })
    return Promise.resolve({ ok: true, text: async () => css })
  }
  const ctx = wallpaperContext()
  plugin.apply(ctx)
  await settle()

  assert.deepEqual(calls, [{ url: '/custom-background/background.css', options: { cache: 'no-store' } }])
  assert.equal(stylesIn(head).length, 1)
  assert.equal(stylesIn(head)[0].textContent, css)
  assert.equal(document.getElementById('dsh-custom-background-boot'), null)

  ctx.disposers.forEach((dispose) => dispose())
  assert.equal(head.children.length, 0)
})

await checkAsync('apply: a missing or failed route leaves the page untouched', async () => {
  for (const impl of [
    () => Promise.resolve({ ok: false, text: async () => '' }),
    () => Promise.reject(new Error('offline')),
  ]) {
    const { head } = installDom()
    installBoot(head)
    globalThis.__DSH_CUSTOM_BACKGROUND__ = undefined
    fetchImpl = impl
    plugin.apply(wallpaperContext())
    await settle()
    assert.equal(stylesIn(head).length, 0)
  }
})

await checkAsync('refresh: adopts the host stylesheet, and a 404 removes it again', async () => {
  const { head } = installDom()
  const state = test.createStylesheetState()
  test.installStylesheet(state, 'old')
  assert.equal(stylesIn(head).length, 1)

  // What a save does: the host already answers with the new values on the same URL.
  fetchImpl = () => Promise.resolve({ ok: true, text: async () => 'new' })
  await test.refreshStylesheet(state)
  assert.equal(stylesIn(head).length, 1)
  assert.equal(stylesIn(head)[0].textContent, 'new', 'the stylesheet must be replaced, not stacked')

  // Turning the feature off in the settings page must restore the stock look.
  fetchImpl = () => Promise.resolve({ ok: false, text: async () => '' })
  await test.refreshStylesheet(state)
  assert.equal(stylesIn(head).length, 0)

  state.live = false
  test.installStylesheet(state, 'late')
  assert.equal(stylesIn(head).length, 0, 'a disposed fiber must not re-install')
})

check('registration: one plugins.row.config entry, keyed by package#row', () => {
  const ctx = pluginContext()
  plugin.apply(ctx)
  assert.deepEqual(ctx.injected, [['slots', 'locale']])
  assert.equal(ctx.registrations.length, 1, 'two active rows for one package break startup')
  assert.equal(ctx.registrations[0].options.name, 'plugins.row.config')
  assert.equal(ctx.registrations[0].options.key, `${test.PACKAGE}#${test.ROW_ID}`)
  assert.equal(ctx.registrations[0].options.locale, test.NS)
})

check('locale: zh and en cover the same keys and label every field', () => {
  const ctx = pluginContext()
  plugin.apply(ctx)
  const zh = ctx.dictionaries[`${test.NS}:zh`]
  const en = ctx.dictionaries[`${test.NS}:en`]
  assert.ok(zh !== undefined && en !== undefined, 'expected zh and en dictionaries')
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort())
  for (const field of test.FIELDS) {
    for (const suffix of ['label', 'hint']) {
      assert.ok(`field.${field.key}.${suffix}` in zh, `missing zh ${suffix} for ${field.key}`)
    }
  }
})

check('form: renders every field from the host values, and the summary view is a one-liner', () => {
  const ctx = pluginContext()
  plugin.apply(ctx)
  const Component = ctx.registrations[0].Component

  const summary = renderToStaticMarkup(h(Component, { view: 'summary' }))
  assert.ok(summary.includes('磨砂'), 'summary must carry the one-line description')

  const value = { enabled: true, image: 'D:/pictures/bg.jpg', blur: 18, dim: 0.25, saturation: 1.05, glass: 1 }
  const form = {
    state: { status: 'ready', value, user: { image: value.image }, revision: 4, writable: true },
    mutate: async () => true,
  }
  const html = renderToStaticMarkup(h(Component, { view: 'page', form }))
  for (const field of test.FIELDS) {
    assert.ok(html.includes(test.ZH[`field.${field.key}.label`]), `missing control for ${field.key}`)
  }
  assert.ok(html.includes('D:/pictures/bg.jpg'), 'the accepted value must be staged into the control')
  assert.ok(html.includes('已覆盖'), 'a user-layer field must be badged as overridden')
  assert.ok(html.includes('保存'), 'the form must carry its own save control')
  assert.ok(html.includes('磨砂') && html.includes('实心'), 'the panels control must offer both materials')
  assert.equal(html.includes('当前配置文档不接受写入'), false)
})

check('form: reports the states the page owner can pass instead of a form', () => {
  const ctx = pluginContext()
  plugin.apply(ctx)
  const Component = ctx.registrations[0].Component
  assert.ok(renderToStaticMarkup(h(Component, { view: 'page' })).includes('没有提供配置表单'))
  const loading = renderToStaticMarkup(h(Component, { view: 'page', form: { state: { status: 'loading' } } }))
  assert.ok(loading.includes('正在读取配置'))
  const unavailable = renderToStaticMarkup(h(Component, { view: 'page', form: { state: { status: 'unavailable' } } }))
  assert.ok(unavailable.includes('无法编辑'))
  const readonly = { state: { status: 'ready', value: {}, user: {}, revision: 1, writable: false }, mutate: async () => true }
  assert.ok(renderToStaticMarkup(h(Component, { view: 'page', form: readonly })).includes('不接受写入'))
})

check('form: switches copy through the bound namespace', () => {
  const ctx = pluginContext()
  plugin.apply(ctx)
  const Component = ctx.registrations[0].Component
  active = 'en'
  try {
    const html = renderToStaticMarkup(h(Component, { view: 'page', form: { state: { status: 'ready', value: {}, revision: 1 } } }))
    assert.ok(html.includes('Glass strength'), 'the English dictionary must be reachable')
  } finally {
    active = 'zh'
  }
})

check('operations: only real changes are sent, with the field\'s own type', () => {
  const value = { enabled: false, image: '', blur: 18, dim: 0.25, saturation: 1.05, glass: 1 }
  const draft = test.draftFrom(value)
  assert.deepEqual(test.operationsFor(draft, value), [], 'an untouched draft writes nothing')

  assert.deepEqual(test.operationsFor({ ...draft, enabled: 'true' }, value), [
    { op: 'set', path: ['enabled'], value: true },
  ])
  assert.deepEqual(test.operationsFor({ ...draft, image: 'D:/x.png' }, value), [
    { op: 'set', path: ['image'], value: 'D:/x.png' },
  ])
  assert.deepEqual(test.operationsFor({ ...draft, blur: '24' }, value), [
    { op: 'set', path: ['blur'], value: 24 },
  ])
  // Floats survive the round trip: the field's kind, not the control's string, decides the type.
  assert.deepEqual(test.operationsFor({ ...draft, glass: '0.5' }, value), [
    { op: 'set', path: ['glass'], value: 0.5 },
  ])
  // Emptied number fields revert to the composition base; an emptied text field is a setting.
  assert.deepEqual(test.operationsFor({ ...draft, blur: '' }, value), [{ op: 'unset', path: ['blur'] }])
  assert.deepEqual(test.operationsFor({ ...draft, image: '' }, { ...value, image: 'D:/x.png' }), [
    { op: 'set', path: ['image'], value: '' },
  ])
})

check('validation: out-of-range and non-numeric drafts are refused locally', () => {
  const translate = (key) => key
  const draft = test.draftFrom({ blur: 18, dim: 0.25, saturation: 1.05, glass: 1 })
  assert.deepEqual(test.problemsWith(draft, translate), [])
  assert.equal(test.problemsWith({ ...draft, blur: '200' }, translate).length, 1)
  assert.equal(test.problemsWith({ ...draft, dim: '-1' }, translate).length, 1)
  assert.equal(test.problemsWith({ ...draft, glass: 'abc' }, translate).length, 1)
})

check('source: the browser half requires nothing but react and touches no other plugin', () => {
  const source = readFileSync(join(root, 'client.js'), 'utf8')
  const requires = [...source.matchAll(/require\('([^']+)'\)/gu)].map((match) => match[1])
  assert.deepEqual(requires, ['react'])
  assert.equal(source.includes('__dsw'), false)
})

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)

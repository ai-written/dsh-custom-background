/**
 * dsh-custom-background — browser half.
 *
 * Two jobs, deliberately independent:
 *
 * 1. **Own the stylesheet.** The host half computes it; this fiber takes ownership of the copy
 *    already on the page, or asks the host for one. The exchange matters twice over: the boot
 *    `<style>` sits in `<head>` before the application stylesheets (so the first paint does not
 *    flash the boot colour), while the runtime copy is a child of this fiber, so an unload or a
 *    hot reload takes the wallpaper and the token overrides away with it.
 * 2. **Draw the configuration form.** The Plugins page offers a form only for a row whose entry
 *    exposes one, and the entry is this file. It registers into the page's `plugins.row.config`
 *    slot under `<package name>#<row id>`, and receives `form.state` (host-owned values, a
 *    revision, and whether the document accepts writes) plus `form.mutate(ops, revision)`.
 *    Nothing is written until Save.
 *
 * Sources for the stylesheet, in order:
 *
 * 1. the `global` boot row, present whenever the carrier renders its index through the host
 *    (no flash, no request);
 * 2. `CSS_ROUTE` over HTTP, for a carrier that renders its own page and never publishes the
 *    injection rows — the Electron desktop host serves its window over its own scheme, while
 *    plugin host routes answer on every carrier observed so far.
 *
 * No `inject` list: the wallpaper must not wait on the theme service, and the form services are
 * injected inside `apply` so a composition without them still gets the background.
 */
window.__ModuleLoader__.load({
  id: 'dsh-custom-background',

  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Bundle package name; the slot key is `<package>#<row id>`. */
    const PACKAGE = 'dsh-custom-background'
    /** The one row this package declares, as its bundle patch names it. */
    const ROW_ID = 'custom-background'
    /** Locale namespace owned by this client half. */
    const NS = 'customBackground'
    /** Marker of this plugin's runtime stylesheet, matched by the client-modules convention. */
    const STYLE_SELECTOR = 'style[data-plugin-css="dsh-custom-background/background.css"]'
    /** Host route the fallback path fetches the stylesheet from. */
    const CSS_ROUTE = '/custom-background/background.css'

    /** Shared copy: actions and sync states. */
    const SHARED_ZH = {
      'action.save': '保存',
      'action.saving': '保存中…',
      'action.reset': '全部恢复默认',
      'badge.overridden': '已覆盖',
      'status.loading': '正在读取配置…',
      'status.unavailable': '宿主没有向本页面提供该配置命名空间，因此这里无法编辑。',
      'status.noForm': '本页面没有提供配置表单。',
      'status.readonly': '当前配置文档不接受写入。',
      'status.saved': '已保存。',
      'status.refused': '宿主拒绝了这次写入。',
      'status.failed': '写入失败：',
      'status.unchanged': '没有改动。',
      'error.number': '必须是数字',
      'option.on': '开',
      'option.off': '关',
      'option.glass': '磨砂',
      'option.solid': '实心',
    }

    const SHARED_EN = {
      'action.save': 'Save',
      'action.saving': 'Saving…',
      'action.reset': 'Reset all to defaults',
      'badge.overridden': 'Overridden',
      'status.loading': 'Reading configuration…',
      'status.unavailable': 'The host does not expose this configuration namespace to this page, so it cannot be edited here.',
      'status.noForm': 'This page supplied no configuration form.',
      'status.readonly': 'The settings document does not accept writes.',
      'status.saved': 'Saved.',
      'status.refused': 'The host refused this write.',
      'status.failed': 'Write failed: ',
      'status.unchanged': 'Nothing changed.',
      'error.number': 'must be a number',
      'option.on': 'On',
      'option.off': 'Off',
      'option.glass': 'Glass',
      'option.solid': 'Solid',
    }

    /**
     * The editable fields, in render order. `min`/`max` mirror the host schema, so the form and
     * a hand-written patch layer reject the same values.
     */
    const FIELDS = [
      { key: 'enabled', kind: 'boolean' },
      { key: 'image', kind: 'text' },
      { key: 'panels', kind: 'select', options: ['glass', 'solid'] },
      { key: 'blur', kind: 'number', min: 0, max: 80, step: 1 },
      { key: 'dim', kind: 'number', min: 0, max: 0.9, step: 0.05 },
      { key: 'saturation', kind: 'number', min: 0, max: 3, step: 0.05 },
      { key: 'glass', kind: 'number', min: 0, max: 1, step: 0.05 },
    ]

    const ZH = {
      summary: '背景图与全站磨砂玻璃：图片地址、模糊、压暗与玻璃强度。',
      intro: '图片可以是本地绝对路径（例如 D:/pictures/bg.jpg）、https 地址或 data: URI；填本地路径时由插件自己的 /custom-background/image 路由提供，换图不必再改配置。保存后刷新页面生效。',
      'field.enabled.label': '启用',
      'field.enabled.hint': '关掉后壁纸与玻璃 token 一并移除，界面恢复原样。',
      'field.image.label': '图片',
      'field.image.hint': '本地绝对路径、https 地址或 data: URI；留空则只有一条警告、不绘制。',
      'field.panels.label': '面板材质',
      'field.panels.hint': '磨砂 = 卡片、气泡、消息内面板也半透明（默认）；实心 = 这些面板保持系统原色，只让画布与侧栏透出壁纸——设置页、代码块、对话框全部按原样清晰显示。',
      'field.blur.label': '模糊（px）',
      'field.blur.hint': '0–80。越大越"磨砂"，背景图对阅读的干扰越小。',
      'field.dim.label': '压暗',
      'field.dim.hint': '0–0.9。在壁纸上叠一层黑色，用来换取文字对比度。',
      'field.saturation.label': '饱和度',
      'field.saturation.hint': '0–3，1 为原图。',
      'field.glass.label': '玻璃强度',
      'field.glass.hint': '0–1：1 = 最透（默认），0 = 最实。每个面板都有自己的可读性下限，所以调小只会让层次更实，不会把设置页变成透明窗口。',
    }

    const EN = {
      summary: 'Background image with site-wide frosted glass: image, blur, dimming and glass strength.',
      intro: 'The image may be an absolute local path (for example D:/pictures/bg.jpg), an https URL, or a data: URI. A local path is served by the plugin\'s own /custom-background/image route, so replacing the file needs no further configuration. Reload the page after saving.',
      'field.enabled.label': 'Enabled',
      'field.enabled.hint': 'Turning this off removes the wallpaper and the glass tokens, restoring the stock look.',
      'field.image.label': 'Image',
      'field.image.hint': 'Absolute local path, https URL, or data: URI. Empty logs one warning and paints nothing.',
      'field.panels.label': 'Panels',
      'field.panels.hint': 'Glass: cards, bubbles and in-message surfaces go translucent too (default). Solid: those surfaces keep the stock fills, and only the canvas and the sidebar show the wallpaper — settings pages, code blocks and dialogs stay exactly as DSH draws them.',
      'field.blur.label': 'Blur (px)',
      'field.blur.hint': '0–80. Higher is more frosted and keeps the image further out of the way of reading.',
      'field.dim.label': 'Dim',
      'field.dim.hint': '0–0.9. Lays black over the wallpaper to buy text contrast.',
      'field.saturation.label': 'Saturation',
      'field.saturation.hint': '0–3, where 1 is the original image.',
      'field.glass.label': 'Glass strength',
      'field.glass.hint': '0–1, where 1 is the default "most transparent" and 0 is the most solid. Every panel has a readability floor, so lowering this makes the layers more solid instead of turning the settings page into a window.',
    }

    const styles = {
      wrap: { display: 'flex', flexDirection: 'column', gap: '16px', paddingTop: '4px' },
      intro: { fontSize: '12px', lineHeight: '1.6', color: 'var(--dsw-alias-label-secondary)' },
      field: { display: 'flex', flexDirection: 'column', gap: '5px' },
      labelRow: { display: 'flex', alignItems: 'center', gap: '6px' },
      label: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' },
      badge: {
        fontSize: '10px', lineHeight: '16px', padding: '0 5px', borderRadius: '4px',
        border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-secondary)',
      },
      control: {
        font: 'inherit', fontSize: '13px', color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '6px', padding: '7px 9px', width: '100%', boxSizing: 'border-box',
      },
      hint: { fontSize: '11px', lineHeight: '1.5', color: 'var(--dsw-alias-label-secondary)' },
      actions: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      primary: {
        font: 'inherit', fontSize: '13px', cursor: 'pointer', border: 'none', borderRadius: '6px',
        padding: '7px 14px', background: 'var(--dsw-alias-brand-primary)', color: '#ffffff',
      },
      secondary: {
        font: 'inherit', fontSize: '13px', cursor: 'pointer', borderRadius: '6px', padding: '6px 12px',
        background: 'transparent', color: 'var(--dsw-alias-label-primary)',
        border: '1px solid var(--dsw-alias-border-l1)',
      },
      ok: { fontSize: '12px', color: 'var(--dsw-alias-state-success-primary)' },
      error: { fontSize: '12px', color: 'var(--dsw-alias-state-error-primary)' },
      muted: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' },
    }

    /** The draft's string form of one value, so controls and comparisons share one shape. */
    function asDraftText(value) {
      if (value === undefined || value === null) return ''
      return typeof value === 'string' ? value : String(value)
    }

    /** The draft object for every field, read from the accepted host values. */
    function draftFrom(value, fields = FIELDS) {
      const source = value !== null && typeof value === 'object' ? value : {}
      const draft = {}
      for (const field of fields) draft[field.key] = asDraftText(source[field.key])
      return draft
    }

    /** Whether the user layer carries this field, which is what marks it overridden. */
    function isOverridden(user, key) {
      return user !== null && typeof user === 'object' && Object.hasOwn(user, key)
    }

    /** Local range validation; the host validates again and answers `false` for a refusal. */
    function problemsWith(draft, t) {
      const problems = []
      for (const field of FIELDS) {
        if (field.kind !== 'number') continue
        const raw = asDraftText(draft[field.key]).trim()
        if (raw === '') continue
        const parsed = Number(raw)
        if (!Number.isFinite(parsed) || parsed < field.min || parsed > field.max) {
          problems.push(`${t(`field.${field.key}.label`)} ${t('error.number')} ${field.min}–${field.max}`)
        }
      }
      return problems
    }

    /**
     * Translate a draft into path operations; only real changes are sent.
     *
     * An emptied number field reverts to its composition base with `unset` (there is no empty
     * number), while an emptied text field is a real setting — an empty image is how the plugin
     * is told to paint nothing — so it is written as `set ''`. Restoring every field is the
     * separate reset action.
     *
     * @param draft - the staged string values.
     * @param value - the accepted host values, for change detection.
     * @returns the ordered operations to submit.
     */
    function operationsFor(draft, value) {
      const source = value !== null && typeof value === 'object' ? value : {}
      const ops = []
      for (const field of FIELDS) {
        const next = asDraftText(draft[field.key])
        const current = source[field.key]
        if (field.kind === 'boolean') {
          const desired = next === 'true'
          if (desired !== (current === true)) ops.push({ op: 'set', path: [field.key], value: desired })
          continue
        }
        if (field.kind === 'number') {
          if (next.trim() === '') {
            if (current !== undefined) ops.push({ op: 'unset', path: [field.key] })
            continue
          }
          const parsed = Number(next)
          if (Number.isFinite(parsed) && parsed !== current) ops.push({ op: 'set', path: [field.key], value: parsed })
          continue
        }
        if (next !== asDraftText(current)) ops.push({ op: 'set', path: [field.key], value: next })
      }
      return ops
    }

    /** One labelled control with its hint and override badge. */
    function Field({ field, draft, user, disabled, t, onChange }) {
      const value = draft[field.key]
      let control
      if (field.kind === 'boolean') {
        control = h('select', {
          style: styles.control,
          value,
          disabled,
          onChange: (event) => onChange(field.key, event.target.value),
        },
        h('option', { key: 'true', value: 'true' }, t('option.on')),
        h('option', { key: 'false', value: 'false' }, t('option.off')))
      } else if (field.kind === 'select') {
        control = h('select', {
          style: styles.control,
          value,
          disabled,
          onChange: (event) => onChange(field.key, event.target.value),
        }, field.options.map((option) => h('option', { key: option, value: option }, t(`option.${option}`))))
      } else {
        control = h('input', {
          style: styles.control,
          type: field.kind === 'number' ? 'number' : 'text',
          inputMode: field.kind === 'number' ? 'decimal' : undefined,
          step: field.step,
          value,
          disabled,
          spellCheck: false,
          onChange: (event) => onChange(field.key, event.target.value),
        })
      }
      return h('div', { style: styles.field },
        h('div', { style: styles.labelRow },
          h('label', { style: styles.label }, t(`field.${field.key}.label`)),
          isOverridden(user, field.key) ? h('span', { style: styles.badge }, t('badge.overridden')) : null),
        control,
        h('div', { style: styles.hint }, t(`field.${field.key}.hint`)))
    }

    /** The configuration body: staged draft, one save, and the host's answer. */
    function ConfigBody({ form, t, refresh }) {
      const snapshot = form?.state
      const status = snapshot?.status
      const value = snapshot?.value
      const user = snapshot?.user
      const revision = snapshot?.revision
      const writable = snapshot?.writable !== false
      const [draft, setDraft] = React.useState(() => draftFrom(value))
      const [notice, setNotice] = React.useState(null)
      const [busy, setBusy] = React.useState(false)

      // Adopt every accepted host value (a save, a reload, someone else's write) unless the
      // reader has staged edits of their own.
      const staged = React.useRef(false)
      React.useEffect(() => {
        if (status !== 'ready' || staged.current) return
        setDraft(draftFrom(value))
      }, [status, revision, value])

      if (form === undefined) return h('div', { style: styles.muted }, t('status.noForm'))
      if (status === 'loading') return h('div', { style: styles.muted }, t('status.loading'))
      if (status === 'unavailable') return h('div', { style: styles.muted }, t('status.unavailable'))

      const disabled = !writable || busy
      const change = (key, next) => {
        staged.current = true
        setDraft((previous) => ({ ...previous, [key]: next }))
        setNotice(null)
      }

      /** Run one batch of operations and report the host's answer. */
      const write = async (ops) => {
        if (ops.length === 0) {
          setNotice({ kind: 'ok', text: t('status.unchanged') })
          return
        }
        setBusy(true)
        try {
          const accepted = await form.mutate(ops, revision)
          if (accepted) {
            staged.current = false
            // The host re-reads its volatile config per request, so its stylesheet route already
            // answers with the new values: adopting it is what makes a save visible without a
            // page reload.
            void refresh?.()
          }
          setNotice(accepted
            ? { kind: 'ok', text: t('status.saved') }
            : { kind: 'error', text: t('status.refused') })
        } catch (error) {
          setNotice({ kind: 'error', text: `${t('status.failed')}${String(error?.message ?? error)}` })
        } finally {
          setBusy(false)
        }
      }

      const save = () => {
        const problems = problemsWith(draft, t)
        if (problems.length > 0) {
          setNotice({ kind: 'error', text: problems.join(' · ') })
          return
        }
        void write(operationsFor(draft, value))
      }

      const reset = () => {
        void write(FIELDS.map((field) => ({ op: 'unset', path: [field.key] })))
      }

      return h('div', { style: styles.wrap },
        h('div', { style: styles.intro }, t('intro')),
        FIELDS.map((field) => h(Field, {
          key: field.key, field, draft, user, disabled, t, onChange: change,
        })),
        h('div', { style: styles.actions },
          h('button', { type: 'button', style: styles.primary, disabled, onClick: save },
            busy ? t('action.saving') : t('action.save')),
          h('button', { type: 'button', style: styles.secondary, disabled, onClick: reset }, t('action.reset')),
          !writable ? h('span', { style: styles.muted }, t('status.readonly')) : null),
        notice === null ? null : h('div', { style: notice.kind === 'ok' ? styles.ok : styles.error }, notice.text))
    }

    /**
     * Build the slot entry. Created inside `apply` so `t` is the namespace binding this client
     * half registered, rather than something the page owner has to inject.
     *
     * @param t - the bound translate function for {@link NS}.
     * @param refresh - adopt the host's current stylesheet; called after every accepted save.
     * @returns the slot component the page renders for `summary` and `page`.
     */
    function makeEntry(t, refresh) {
      return function CustomBackgroundEntry(props) {
        const translate = typeof props.t === 'function' ? props.t : t
        if (props.view !== 'page') return h('span', null, translate('summary'))
        return h(ConfigBody, { form: props.form, t: translate, refresh })
      }
    }

    /**
     * One fiber's stylesheet state: the element it owns and whether the fiber is still alive.
     * A plain object, so the refresh path can be driven directly in tests.
     *
     * @returns a fresh state with no element.
     */
    function createStylesheetState() {
      return { live: true, tag: null }
    }

    /** Append one stylesheet as this plugin's own; a later call replaces the previous one. */
    function installStylesheet(state, css) {
      if (!state.live || typeof css !== 'string' || css === '') return
      removeStylesheet(state)
      const tag = document.createElement('style')
      tag.dataset.plugin = PACKAGE
      tag.dataset.pluginCss = 'dsh-custom-background/background.css'
      tag.textContent = css
      document.head.append(tag)
      state.tag = tag
    }

    /** Drop this plugin's stylesheet, restoring the stock look. */
    function removeStylesheet(state) {
      if (state.tag === null) return
      state.tag.remove()
      state.tag = null
    }

    /**
     * Ask the host for the current stylesheet and adopt it, replacing whatever is installed.
     *
     * This is what makes a saved parameter visible without a reload: the host re-reads its
     * volatile config per request, so the same URL answers with the new values. A 404 — the
     * plugin switched off, or a carrier without the route — removes the stylesheet instead of
     * leaving a stale one behind, so turning the feature off in the settings page restores the
     * stock look live.
     *
     * @param state - the fiber's stylesheet state.
     * @returns a promise settling after the attempt, for callers that want to sequence on it.
     */
    function refreshStylesheet(state) {
      const fail = () => {}
      try {
        return fetch(CSS_ROUTE, { cache: 'no-store' })
          .then((response) => (response.ok ? response.text() : ''))
          .then((css) => {
            if (typeof css === 'string' && css !== '') installStylesheet(state, css)
            else removeStylesheet(state)
          })
          .catch(fail)
      } catch {
        // No fetch in this carrier; nothing to fall back to.
        return Promise.resolve()
      }
    }

    return {
      /**
       * Own the stylesheet, then register the row's configuration page.
       *
       * @param ctx - client plugin context.
       */
      apply(ctx) {
        // The boot payload is preferred: it is already on the page, so the first paint is
        // right. Without it (the Electron desktop carrier does not render the injection rows)
        // the host route is asked instead.
        const boot = document.getElementById('dsh-custom-background-boot')
        if (boot !== null) boot.remove()
        // A hot reload re-runs apply in the same document: drop any surviving copy first.
        const stale = document.querySelector(STYLE_SELECTOR)
        if (stale !== null) stale.remove()

        const state = createStylesheetState()
        ctx.effect(() => () => {
          state.live = false
          removeStylesheet(state)
        })

        const payload = globalThis.__DSH_CUSTOM_BACKGROUND__
        const hasPayload = payload !== null && typeof payload === 'object' &&
          payload.enabled === true && typeof payload.css === 'string'
        if (hasPayload) installStylesheet(state, payload.css)
        else void refreshStylesheet(state)

        // The form needs the slot registry and the locale registry; the wallpaper above does
        // not, so it is not gated on them.
        ctx.inject(['slots', 'locale'], (child) => {
          child.effect(() => child.locale.register(NS, 'zh', { ...SHARED_ZH, ...ZH }))
          child.effect(() => child.locale.register(NS, 'en', { ...SHARED_EN, ...EN }))
          // bind() reads the active locale at call time, so a language switch re-renders
          // through the shared locale revision without re-registering the slot.
          const t = child.locale.bind(NS)
          child.slots.inject('plugins.row.config', () => child.slots.register({
            name: 'plugins.row.config',
            key: `${PACKAGE}#${ROW_ID}`,
            locale: NS,
          }, makeEntry(t, () => refreshStylesheet(state))))
        })
      },

      // Test seam. The Cordis loader ignores unknown properties, and these pure helpers are the
      // part of this half that decides what a save writes; exposing them lets `test/client.mjs`
      // exercise that offline, since the page cannot be driven here.
      __test: {
        FIELDS,
        asDraftText,
        createStylesheetState,
        draftFrom,
        installStylesheet,
        isOverridden,
        operationsFor,
        problemsWith,
        makeEntry,
        refreshStylesheet,
        removeStylesheet,
        PACKAGE,
        ROW_ID,
        NS,
        ZH,
        EN,
      },
    }
  },
})

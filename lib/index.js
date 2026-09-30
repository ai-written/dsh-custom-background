/**
 * dsh-custom-background — host half.
 *
 * Paints a background image behind the whole DSH web GUI and makes the surfaces that sit on
 * top of it translucent, so the image shows through them as frosted glass.
 *
 * How it reaches the page, and why this shape:
 *
 * - The wallpaper and the token overrides are ONE generated stylesheet. The host computes it
 *   once per index render and publishes it twice: as a `global` row (the browser half reads
 *   it back at runtime, so HMR and a reload after a config change apply the same bytes) and
 *   as a `<style id="dsh-custom-background-boot">` head row (so the first paint already
 *   carries the image instead of flashing the boot colour). The browser half removes the boot
 *   element and installs its own plugin-owned copy.
 * - Selectors are `html body…`, not `body…`: the palette is declared on `body` (and re-declared
 *   on `body[data-ds-dark-theme]`), and the head row lands *before* the application stylesheets.
 *   One extra element in the selector wins on specificity without `!important`, which would
 *   otherwise outrank the inline token writes a third-party theme makes through `ctx.theme`.
 * - Dark mode is attribute-driven in DSH (`body[data-ds-dark-theme]`); there is no
 *   `prefers-color-scheme` CSS anywhere in the client, so the pair of rules below is the whole
 *   light/dark story.
 * - The wallpaper is `body::before` with `z-index:-1`: it paints above the canvas background
 *   and below `#root`, so it can never cover content, and it needs no DOM insertion.
 *
 * This package has no dependencies on purpose: a `link:`-ed plugin resolves its imports from
 * its own directory, so a dependency here would need its own install to keep working.
 *
 * @module dsh-custom-background
 */

import { existsSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { extname, resolve } from 'node:path'
import { homedir } from 'node:os'
import z from '@deepseek-ai/schemastery'

/** Stable cordis plugin name. */
export const name = 'custom-background'

/** `globalThis` key carrying the resolved payload to the browser half. */
export const GLOBAL_NAME = '__DSH_CUSTOM_BACKGROUND__'

/** Id of the boot `<style>` element the browser half replaces. */
export const STYLE_ID = 'dsh-custom-background-boot'

/** Path serving the configured local image. */
export const ROUTE_PATH = '/custom-background/image'

/**
 * Path serving the generated stylesheet itself.
 *
 * This is the fallback delivery path. The index-injection rows below are what keep the first
 * paint from flashing, but a carrier is free to render its own page and never emit them — the
 * Electron desktop host serves the window over its own scheme and answers plugin routes on its
 * own web server, so a plugin cannot assume every carrier reads its injection rows. Host routes
 * are the one delivery path every observed carrier honors, hence this route.
 */
export const CSS_ROUTE = '/custom-background/background.css'

/** Marker the browser half stamps on its own stylesheet. */
export const PLUGIN_CSS_ID = 'dsh-custom-background/background.css'

/** Panel-material modes: whether content surfaces join the glass or keep their stock fill. */
export const PANEL_MODES = Object.freeze(['glass', 'solid'])

/** Configuration defaults; every field is optional in the patch layer. */
export const DEFAULTS = Object.freeze({
  enabled: false,
  image: '',
  blur: 18,
  dim: 0.25,
  saturation: 1.05,
  glass: 1,
  panels: 'glass',
})

/**
 * Loader config schema, and the reason the row is editable at all.
 *
 * The Plugins page shows a form only for an entry the Host settings service reports, and that
 * service skips an entry twice over unless its fields are **volatile**
 * (`volatileForm(schema) === undefined` ⇒ no descriptor, and a write to a non-volatile path is
 * refused by `isVolatilePath`). Volatile means "editable live": the write lands in the profile
 * patch layer, the loader re-applies this plugin, and `apply` rebuilds the stylesheet and its
 * routes from the new values. Every field therefore carries `.volatile()`, exactly as the
 * shipped theme plugin's Config does.
 *
 * The bounds mirror the browser half's field table, so the form and a hand-written patch layer
 * reject the same values. {@link normalizeConfig} still clamps at apply time — a schema value
 * can still be one this module must guard (an older document, a `!!js` expression).
 */
export const Config = z.object({
  enabled: z.boolean().default(DEFAULTS.enabled).volatile(),
  image: z.string().default(DEFAULTS.image).volatile(),
  blur: z.number().min(0).max(80).default(DEFAULTS.blur).volatile(),
  dim: z.number().min(0).max(0.9).default(DEFAULTS.dim).volatile(),
  saturation: z.number().min(0).max(3).default(DEFAULTS.saturation).volatile(),
  glass: z.number().min(0).max(1).default(DEFAULTS.glass).volatile(),
  panels: z.union([...PANEL_MODES]).default(DEFAULTS.panels).volatile(),
})

/**
 * The surfaces that would otherwise stay opaque in front of the wallpaper, as
 * `[token, light base colour, dark base colour, alpha at glass: 1, alpha floor, group]`.
 *
 * Every entry is a semantic `--dsw-*` token from `@deepseek-ai/dsh-client-ui-theme`, so the tint
 * follows the palette instead of restating it. The table is a **ladder**, and the ladder is the
 * whole design: the canvas is the most transparent so the picture reads as a picture, chrome sits
 * in between, and anything that carries text sits high enough to stay legible.
 *
 * The floor is why the ladder survives a small `glass`: raising the value lowers each alpha from
 * its full value toward its floor, never below it. `glass: 0` therefore means "as solid as this
 * design gets", not "no panel fills".
 *
 * The group is the second escape hatch. `canvas` is the picture's own surface; `panels` is
 * everything drawn on top of it — settings pages, cards, bubbles, in-message surfaces. Under
 * `panels: 'solid'` the panel group is left alone entirely, so those surfaces keep the stock DSH
 * fills while the wallpaper still shows through the canvas and the sidebar. That is the mode to
 * pick when the picture must not sit behind anything that carries text.
 *
 * Toast, tooltip and hover-card surfaces are deliberately absent: they are transient floating
 * text, and translucency there costs legibility without buying any visible image.
 */
export const GLASS_TOKENS = Object.freeze([
  // canvas: the picture lives here
  ['--dsw-alias-bg-base', 'var(--dsw-static-neutral-bluish-00)', 'var(--dsw-static-neutral-bluish-950)', 0.52, 0.3, 'canvas'],
  ['--dsw-specific-sidebar-fill', 'var(--dsw-static-neutral-bluish-50)', 'var(--dsw-static-neutral-bluish-900)', 0.62, 0.45, 'canvas'],
  // panels: everything drawn over the picture
  ['--dsw-alias-bg-layer-1', 'var(--dsw-static-neutral-bluish-00)', 'var(--dsw-static-neutral-bluish-875)', 0.86, 0.72, 'panels'],
  ['--dsw-alias-bg-layer-2', 'var(--dsw-static-neutral-bluish-00)', 'var(--dsw-static-neutral-bluish-850)', 0.9, 0.8, 'panels'],
  ['--dsw-alias-bg-layer-3', 'var(--dsw-static-neutral-bluish-00)', 'var(--dsw-static-neutral-bluish-800)', 0.92, 0.84, 'panels'],
  ['--dsw-alias-bg-module-platform', 'var(--dsw-static-neutral-bluish-60)', 'var(--dsw-static-neutral-bluish-800)', 0.88, 0.76, 'panels'],
  ['--dsw-specific-bubble', 'var(--dsw-static-deepseek-50)', 'var(--dsw-static-neutral-bluish-850)', 0.88, 0.74, 'panels'],
  ['--dsw-specific-input-major', 'var(--dsw-static-neutral-bluish-00)', 'var(--dsw-static-neutral-bluish-850)', 0.92, 0.84, 'panels'],
  ['--dsw-alias-markdown-code-block', 'var(--dsw-static-neutral-bluish-50)', 'var(--dsw-static-neutral-bluish-900)', 0.92, 0.86, 'panels'],
  ['--dsw-alias-bg-document-preview', 'var(--dsw-static-neutral-bluish-100)', 'var(--dsw-static-neutral-bluish-950)', 0.94, 0.88, 'panels'],
])

/** Content type per served image extension. */
const MIME = Object.freeze({
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
})

/**
 * Read one config field.
 *
 * A schema field marked `.volatile()` reaches `apply` as an accessor object with a `get()`
 * method, not as a plain value — that is what makes a live write visible without remounting
 * (`config.preference.get()` in the shipped theme plugin is the same shape). Everything else,
 * including a config document read straight from YAML, is already a plain value.
 *
 * @param value - one field of the loader's config object.
 * @returns the live value.
 */
function readField(value) {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') return value.get()
  return value
}

/** Clamp a configuration number, falling back when the value is absent or not a finite number. */
function clampNumber(value, min, max, fallback) {
  if (value === null || value === undefined || value === '') return fallback
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

/**
 * Validate and normalise the loader config. Unknown fields are ignored and every field is
 * clamped, because a bad value here would otherwise fail at CSS computed-value time, where
 * the failure is a silently missing background.
 *
 * @param raw - the loader's config object (volatile accessors or plain values), or anything else.
 * @returns a complete, in-range configuration.
 */
export function normalizeConfig(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const enabled = readField(source.enabled)
  const image = readField(source.image)
  const panels = readField(source.panels)
  return {
    enabled: enabled === true || enabled === 'true',
    image: typeof image === 'string' ? image.trim() : '',
    blur: clampNumber(readField(source.blur), 0, 80, DEFAULTS.blur),
    dim: clampNumber(readField(source.dim), 0, 0.9, DEFAULTS.dim),
    saturation: clampNumber(readField(source.saturation), 0, 3, DEFAULTS.saturation),
    glass: clampNumber(readField(source.glass), 0, 1, DEFAULTS.glass),
    panels: PANEL_MODES.includes(panels) ? panels : DEFAULTS.panels,
  }
}

/**
 * A scheme-qualified URL: the browser fetches it itself and the host never touches the disk.
 *
 * A leading `/` is deliberately **not** on this list. On Windows a filesystem path looks like
 * `D:\pics\bg.png`, but on Linux and macOS it looks like `/home/me/bg.png` — treating every
 * leading slash as a URL meant such a path was never resolved as a file at all, so the plugin
 * worked on Windows and silently painted nothing everywhere else. Whether a leading slash names
 * a file or a path the application already serves is decided per call, by looking at the disk
 * ({@link resolveImagePath} first, then a served path in {@link resolveImageUrl}).
 */
const URL_SCHEME = /^(?:https?:|data:|blob:)/iu

/**
 * Whether the image is a URL with its own scheme, so no host route is involved.
 *
 * @param image - configured image value.
 * @returns true when the value is scheme-qualified.
 */
export function isRemoteImage(image) {
  return URL_SCHEME.test(image)
}

/**
 * Turn a `file:` URL into the local path it names; every other value passes through.
 *
 * A path copied out of a browser arrives as `file:///D:/dir/a.png`, which is a local file in
 * every sense except its spelling. Percent-escapes are decoded so a path with spaces or
 * non-ASCII characters survives the trip; `file://host/share/...` keeps its UNC form.
 *
 * @param image - configured image value.
 * @returns the path form to resolve.
 */
function fromFileUrl(image) {
  if (!/^file:\/\//iu.test(image)) return image
  let rest = image.replace(/^file:\/\/(?:localhost)?/iu, '')
  try {
    rest = decodeURIComponent(rest)
  } catch {
    // A malformed escape is not worth failing over: the raw form is still what the user meant.
  }
  if (/^\/[A-Za-z]:/u.test(rest)) return rest.slice(1) // /D:/dir → D:/dir
  if (rest.startsWith('/')) return rest // POSIX absolute path
  return `//${rest}` // file://host/share → \\host\share
}

/**
 * Resolve a local image path, expanding a leading `~` and unwrapping a `file:` URL. Returns
 * null when the value is empty, is a URL the browser fetches itself, or does not name an
 * existing file.
 *
 * @param image - configured image value.
 * @returns absolute file path, or null.
 */
export function resolveImagePath(image) {
  if (image === '' || isRemoteImage(image)) return null
  let candidate = fromFileUrl(image)
  if (candidate === '~' || candidate.startsWith('~/') || candidate.startsWith('~\\')) {
    candidate = homedir() + candidate.slice(1)
  }
  const absolute = resolve(candidate)
  try {
    if (!existsSync(absolute) || !statSync(absolute).isFile()) return null
  } catch {
    return null
  }
  return absolute
}

/**
 * Quote one CSS `url()` value so a quote or backslash in the value cannot end the token.
 *
 * `<` is percent-encoded as well: the generated stylesheet is embedded in a `<style>` element,
 * and a value containing `</style` would otherwise close that element early.
 */
function cssUrl(image) {
  return `url("${String(image).replaceAll('\\', '%5C').replaceAll('"', '%22').replaceAll('<', '%3C')}")`
}

/** One translucent palette token: the palette colour mixed with transparency. */
function glassValue(base, alpha) {
  const percent = Math.round(Math.min(1, Math.max(0, alpha)) * 100)
  return `color-mix(in srgb, ${base} ${percent}%, transparent)`
}

/**
 * One surface's opacity for a given glass strength.
 *
 * `glass: 1` is the full value; lowering it moves toward the floor and stops there. Interpolating
 * toward zero instead is what let a small `glass` turn a text-bearing panel into a window.
 *
 * @param alpha - opacity at `glass: 1`.
 * @param floor - lowest opacity this surface may reach.
 * @param glass - configured strength in 0..1.
 * @returns opacity in `floor..alpha`.
 */
export function glassAlpha(alpha, floor, glass) {
  return floor + (alpha - floor) * glass
}

/**
 * Build the complete stylesheet: the wallpaper layer, its tuning variables, and the
 * light/dark token overrides.
 *
 * @param config - normalised configuration.
 * @param imageUrl - absolute URL the browser can fetch the image from.
 * @returns CSS text; never contains `</style`.
 */
export function buildCss(config, imageUrl) {
  const light = []
  const dark = []
  // `panels: 'solid'` leaves every content surface at its stock fill: the wallpaper stops behind
  // the canvas and the sidebar, and nothing that carries text is repainted.
  const groups = config.panels === 'solid' ? ['canvas'] : ['canvas', 'panels']
  for (const [token, lightBase, darkBase, alpha, floor, group] of GLASS_TOKENS) {
    if (!groups.includes(group)) continue
    const scaled = glassAlpha(alpha, floor, config.glass)
    light.push(`  ${token}: ${glassValue(lightBase, scaled)};`)
    dark.push(`  ${token}: ${glassValue(darkBase, scaled)};`)
  }
  const bleed = Math.min(140, Math.round(config.blur * 3) + 8)
  return [
    '/* dsh-custom-background — generated from the plugin config; do not edit. */',
    'html body {',
    `  --dsh-custom-background-image: ${cssUrl(imageUrl)};`,
    `  --dsh-custom-background-blur: ${config.blur}px;`,
    `  --dsh-custom-background-bleed: ${bleed}px;`,
    `  --dsh-custom-background-dim: ${config.dim};`,
    `  --dsh-custom-background-saturation: ${config.saturation};`,
    ...light,
    '}',
    'html body[data-ds-dark-theme] {',
    ...dark,
    '}',
    'html body::before {',
    '  content: "";',
    '  position: fixed;',
    '  inset: calc(-1 * var(--dsh-custom-background-bleed));',
    '  z-index: -1;',
    '  pointer-events: none;',
    '  background-image: linear-gradient(rgba(0, 0, 0, var(--dsh-custom-background-dim)), rgba(0, 0, 0, var(--dsh-custom-background-dim))), var(--dsh-custom-background-image);',
    '  background-position: center;',
    '  background-size: cover;',
    '  background-repeat: no-repeat;',
    '  filter: blur(var(--dsh-custom-background-blur)) saturate(var(--dsh-custom-background-saturation));',
    '}',
    '',
  ].join('\n')
}

/**
 * Serve the configured image. The file is read per request so replacing it takes effect on
 * the next reload without touching the profile.
 *
 * @param request - node:http request.
 * @param response - node:http response.
 * @param filePath - absolute path of the configured image.
 */
async function serveImage(request, response, filePath) {
  const method = request.method ?? 'GET'
  if (method !== 'GET' && method !== 'HEAD') {
    response.writeHead(405, { allow: 'GET, HEAD' })
    response.end()
    return
  }
  try {
    const body = await readFile(filePath)
    response.writeHead(200, {
      'content-type': MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
      'content-length': String(body.byteLength),
      'cache-control': 'no-store',
    })
    response.end(method === 'HEAD' ? undefined : body)
  } catch {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('custom-background: configured image is not readable\n')
  }
}

/**
 * Serve one generated text body.
 *
 * @param request - node:http request.
 * @param response - node:http response.
 * @param body - text body to serve.
 * @param contentType - `content-type` header value.
 */
function serveText(request, response, body, contentType) {
  const method = request.method ?? 'GET'
  if (method !== 'GET' && method !== 'HEAD') {
    response.writeHead(405, { allow: 'GET, HEAD' })
    response.end()
    return
  }
  response.writeHead(200, {
    'content-type': contentType,
    'content-length': String(Buffer.byteLength(body)),
    'cache-control': 'no-store',
  })
  response.end(method === 'HEAD' ? undefined : body)
}

/**
 * Short, stable version token for one image file: its path, mtime and size decide it.
 *
 * The token exists because of a browser behaviour, not a coding preference. A local image is
 * always served from the same route, so switching from `a.png` to `b.jpg` produces a byte-identical
 * stylesheet; re-applying identical CSS does **not** make the browser reload a resource it already
 * has decoded, so the picture kept showing the old file until the page was reloaded. Putting the
 * file's identity in the URL makes every real change a different URL, and no change at all when
 * nothing changed. `statSync` is the only read here: the browser still fetches the bytes through
 * the route.
 *
 * @param filePath - absolute path of the configured image.
 * @returns a 12-character hex token.
 */
export function imageVersion(filePath) {
  try {
    const info = statSync(filePath)
    return createHash('sha1')
      .update(`${filePath}\u0000${info.mtimeMs}\u0000${info.size}`)
      .digest('hex')
      .slice(0, 12)
  } catch {
    return 'missing'
  }
}

/**
 * Resolve the URL the browser should fetch the configured image from, or null when there is
 * nothing to paint.
 *
 * Three cases, in this order:
 *
 * 1. **a file on disk** wins on every platform — that is the fix for a leading `/`, which is a
 *    filesystem path on Linux and macOS. Its URL carries {@link imageVersion}, so changing the
 *    path — or replacing the file in place — yields a different URL and the browser re-fetches
 *    without a page reload;
 * 2. **a scheme-qualified URL** is used verbatim;
 * 3. **a leading `/` that names no file** is a path the application already serves, and is used
 *    verbatim (this is what keeps `/assets/bg.jpg` working).
 *
 * @param config - normalised configuration.
 * @returns an absolute or root-relative URL, or null.
 */
export function resolveImageUrl(config) {
  if (config.image === '') return null
  const filePath = resolveImagePath(config.image)
  if (filePath !== null) return `${ROUTE_PATH}?v=${imageVersion(filePath)}`
  if (isRemoteImage(config.image)) return config.image
  if (config.image.startsWith('/')) return config.image
  return null
}

/** Answer 404 for a route whose configuration currently paints nothing. */
function serveAbsent(response, message) {
  response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
  response.end(`${message}\n`)
}

/**
 * Host plugin body: serve the stylesheet and the image over host routes, and publish the same
 * stylesheet into every index render.
 *
 * **Every use re-reads the config, and nothing is decided once at apply time.** A field marked
 * `.volatile()` reaches this function as an accessor whose `get()` returns the *current* value;
 * that is the whole point of volatility — a settings write is visible without remounting the
 * plugin. Freezing the stylesheet or the image path here (reading `config` once) is exactly the
 * bug that made a saved parameter change do nothing until the next app start. Registering the
 * routes unconditionally is the same idea from the other side: switching the plugin on, or
 * pointing it at an image, through the settings page takes effect without a restart.
 *
 * Two delivery paths, because no single one covers every carrier:
 *
 * - `webserver/index-inject` rows reach a page whose index the host renders itself, and they
 *   land before the first paint. Not every carrier renders that page (the Electron desktop host
 *   serves its window over its own scheme).
 * - {@link CSS_ROUTE} answers the same stylesheet over HTTP, which the browser half fetches at
 *   mount and again after every save. Plugin host routes are served by both carriers.
 *
 * A misconfiguration is reported once at apply time and then simply paints nothing; it must
 * never keep the host from starting.
 *
 * @param ctx - host plugin context.
 * @param rawConfig - the row's `config` value from the patch layer (volatile accessors).
 */
export function apply(ctx, rawConfig) {
  /** Read the configuration as it stands right now, not as it stood at apply time. */
  const live = () => normalizeConfig(rawConfig)

  const boot = live()
  if (boot.enabled) {
    if (boot.image === '') {
      ctx.logger?.warn?.('custom-background: enabled without an image; nothing is painted until one is set')
    } else if (resolveImageUrl(boot) === null) {
      ctx.logger?.warn?.(`custom-background: image not found: ${boot.image}; nothing is painted until it resolves`)
    }
  }

  ctx.inject(['webServer'], (web) => {
    web.effect(() => web.webServer.register({
      kind: 'exact',
      path: CSS_ROUTE,
      handler: (request, response) => {
        const config = live()
        const imageUrl = config.enabled ? resolveImageUrl(config) : null
        if (imageUrl === null) {
          serveAbsent(response, 'custom-background: nothing to paint')
          return
        }
        serveText(request, response, buildCss(config, imageUrl), 'text/css; charset=utf-8')
      },
    }), 'custom-background: stylesheet route')

    web.effect(() => web.webServer.register({
      kind: 'exact',
      path: ROUTE_PATH,
      handler: (request, response) => {
        const config = live()
        const filePath = config.enabled ? resolveImagePath(config.image) : null
        if (filePath === null) {
          serveAbsent(response, 'custom-background: configured image is not readable')
          return
        }
        // Returning the promise keeps the handler awaitable (the webserver accepts either);
        // tests use that to read the body it wrote.
        return serveImage(request, response, filePath)
      },
    }), 'custom-background: image route')
  })

  ctx.on('webserver/index-inject', (table) => {
    const config = live()
    if (!config.enabled) return
    const imageUrl = resolveImageUrl(config)
    if (imageUrl === null) return
    const css = buildCss(config, imageUrl)
    table.push({ kind: 'global', name: GLOBAL_NAME, value: { enabled: true, css } })
    table.push({ kind: 'html', placement: 'head', html: `<style id="${STYLE_ID}">${css}</style>` })
  })
}

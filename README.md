# dsh-custom-background

给 DeepSeek Harness 的 Web GUI 加背景图，并把盖在它上面的界面做成**全站磨砂玻璃**。

- **宿主半**（`lib/index.js`）读配置、必要时用一条专用路由把本地图片发给浏览器，并把生成好的样式表注入每个 index 响应。
- **浏览器半**（`client.js`）把首帧用的引导样式换成自己这个插件所持有的副本，卸载 / 热重载时随插件一起消失。

没有依赖（`link:` 安装的插件只会从自己的目录解析 import，多一个依赖就多一次安装才不坏）。

## 安装

**CLI 的 `web` 等 profile**：`dsh plugin --profile web add "dsh-custom-background@link:D:/code/github/dsh-custom-background"`
（它会同时写好依赖和 `dsh.profile.bundles`），然后在 profile 的 `cordis.patch.yml` 里配置。

**Electron 桌面版的 `desktop` profile**：`dsh plugin` 会拒绝（`profile "desktop" is managed exclusively by the Electron application`），手工两步：

1. 在 `$DSH_HOME/profiles/desktop/package.json` 的 `dependencies` 加
   `"dsh-custom-background": "link:D:/code/github/dsh-custom-background"`，
   并把包名加进 `dsh.profile.bundles`，然后在 profile 目录跑 `pnpm install`；
2. 在同一个 profile 的 `cordis.patch.yml` 里加下面的配置行。

配置行（两个 profile 通用）：

   ```yaml
   - id: custom-background
     config:
       enabled: true
       image: D:/pictures/wallpaper.jpg   # 本地路径、https URL、data: 或 / 开头的同源路径
       blur: 18          # 壁纸模糊半径 px，0–80
       dim: 0.25         # 壁纸压暗 0–0.9，用来保住文字对比度
       saturation: 1.05  # 壁纸饱和度 0–3
       glass: 1          # 玻璃强度 0–1，等比缩放下面那张表里的所有不透明度
   ```

3. 重启（新增 bundle 需要重新组合插件树；只改 `config` 时 `patchReload: live` 的 profile 刷新页面即可）。

## 在界面里配置

除了 YAML，插件也把配置页注册进「插件」页：**插件 → dsh-custom-background → 该行的「配置」**，进去是六个字段（启用 / 图片 / 模糊 / 压暗 / 饱和度 / 玻璃强度）加「保存」「全部恢复默认」。**保存即生效，不用刷新页面**（见下面「实时」一节）。

- 表单与 YAML 是**同一份数据**：保存走宿主配置文档（也就是 profile 的 `cordis.patch.yml`），两侧随时可以混着改。注意：**手改 YAML 仍需重启桌面版**（profile 没有 `patchReload: live`），界面保存则不需要。
- 徽标「已覆盖」表示该字段由用户层显式给出（YAML 里写过）；「全部恢复默认」是对每个字段发 `unset`，把它退回组合基线的默认值。
- 字段范围与宿主 schema 一致（模糊 0–80、压暗 0–0.9、饱和度 0–3、玻璃 0–1），越界在本地就被挡下，宿主还会再校验一次。
- 需要一个导出 `Config` schema 的宿主半才会出现可写表单；本插件导出的是 `@deepseek-ai/schemastery` 的 `z.object`，也是它唯一的运行期依赖。
- **字段必须标 `.volatile()`**，这是最容易漏的一步：宿主 `SettingsForms.describe()` 用 `volatileForm(schema)` 过滤，一个 volatile 字段都没有的条目会被整行跳过——页面上就表现为「本页面没有提供配置表单」，写入也会被 `isVolatilePath` 拒绝。
- 因此 `apply` 拿到的 volatile 字段是**带 `get()` 的访问器**而不是值（与 ui-theme 的 `config.preference.get()` 同形），`normalizeConfig` 用 `readField()` 统一解包；访问器与 YAML 普通值两种形态都支持。

实现走的是「插件页给的三个配置槽」里的 `plugins.row.config`，键为 `<包名>#<行 id>`（这里是 `dsh-custom-background#custom-background`），页面回传 `form.state`（值、revision、是否可写）与 `form.mutate(ops, revision)`；**只有点保存才写入**。

### 实时：保存后不必刷新

volatile 的语义是「可热改」——宿主保存时调 `resolveConfig(fiber.runtime, …)` **就地更新运行中实例的配置**，不重挂载插件。所以插件侧必须做两件事，否则就会出现「保存了但界面没变」：

1. **宿主半不在 `apply` 时读配置，而是每次用的时候现读**。`apply` 里只做启动诊断；样式表路由、图片路由、index 注入三处各自 `live()` 一次，读到的永远是当前值。把 `buildCss` 的结果或图片绝对路径在 `apply` 里算一次缓存起来，就会把插件冻结在启动那一刻的配置上。两条路由也因此**无条件注册**，靠配置决定应答 200 还是 404 —— 这样把「启用」打开、或换一张图，都不需要重启。
2. **浏览器半在保存成功后重新拉一次样式表**。`form.mutate` 返回接受后调用 `refreshStylesheet()`：宿主同一 URL 已经返回新值，客户端替换掉自己那个 `<style>`；若返回 404（功能被关掉）则把样式表**移除**，界面即时恢复原样。
3. **本地图片的 URL 带版本号**（`/custom-background/image?v=<路径+mtime+大小的 sha1 前 12 位>`）。只有前两条还不够：本地图片永远走同一条路由，从 `a.png` 换成 `b.jpg` 时样式表文本**一个字节都没变**，而浏览器对内容相同的样式重应用不会重新下载已解码的资源——表现就是「改了图片没反应，重启才生效」。把文件身份写进 URL 之后，换路径、或原地替换文件，都会得到一条新 URL，浏览器必然重新取图；文件没变则 URL 不变，不做无谓请求。

宿主侧同样受益：换掉本地图片文件后，**刷新页面或重新保存一次**就能看到新图（URL 已随文件变化），不必改配置、更不必重启。

## 它是怎么工作的

**壁纸层**：`body::before{position:fixed;inset:-bleed;z-index:-1}` —— 画在画布背景之上、`#root` 之下，所以**不可能盖住任何内容**，也不需要往 DOM 里插节点。压暗用 `linear-gradient` 和图片写在同一层 `background-image` 里，同样是零层级风险。模糊直接作用在这一层，因此**不需要给任何面板加 `backdrop-filter`**：DSH 的浮层用 `backdrop-filter` 时都要求把滤镜放在 `position:absolute;inset:0;z-index:-1` 的子层上（否则会创建 backdrop root / 新的 fixed 包含块），我们绕开了整类问题。

**玻璃**：把 DSH 语义 token 换成「调色板颜色 + 透明度」的 `color-mix()`。这是一条**阶梯**，阶梯本身就是设计：画布最透（图才像图），界面骨架居中，凡是承载文字的面板都压得足够实。默认值（`glass: 1`）与各自的下限：

| token | 管什么 | glass 1 | 下限 |
|---|---|---|---|
| `--dsw-alias-bg-base` | 主框架、中栏、整页设置 | 52% | 30% |
| `--dsw-specific-sidebar-fill` | 左栏（两层） | 62% | 45% |
| `--dsw-alias-bg-layer-1/2/3` | 卡片、右栏面板、对话框 | 86 / 90 / 92% | 72 / 80 / 84% |
| `--dsw-alias-bg-module-platform` | 设置卡、工具栏 | 88% | 76% |
| `--dsw-specific-bubble` | 用户消息气泡 | 88% | 74% |
| `--dsw-specific-input-major` | 消息内卡片（审批 / 提问 / 附件） | 92% | 84% |
| `--dsw-alias-markdown-code-block` | 代码块、终端 / 网页块 | 92% | 86% |
| `--dsw-alias-bg-document-preview` | 右栏文档预览 | 94% | 88% |

**下限是必须的**：设置面板铺在 `layer-2` / `module-platform` 上，如果 `glass` 把它们一路降到透明，设置页就会变成一扇看得到壁纸的窗（文字直接压在图上）。所以 `glass` 是从「全值」往「下限」插值，`glass: 0` 的含义是「本设计最实」，而不是「面板底色全去掉」。

**`panels`：内容面板要不要一起磨砂。**

| 值 | 效果 |
|---|---|
| `glass`（默认） | 上表全部生效：卡片、气泡、代码块、对话框都半透明。 |
| `solid` | **只覆盖画布与侧栏**（`--dsw-alias-bg-base`、`--dsw-specific-sidebar-fill`），`layer-*` / `module-platform` / `bubble` / `input-major` / `markdown-code-block` / `document-preview` 一个都不动 —— 设置页、卡片、代码块、对话框全部保持 DSH 原色，壁纸只在画布与侧栏透出来。 |

`solid` 是「背景图 + 原生界面」那一档：图片仍然铺满整个窗口（壁纸层照画），但凡是要读字的地方都由系统自己铺底，所以设置页不可能发虚。在配置页里改「面板材质」即可切换，保存即时生效。此时 `glass` 只作用于画布与侧栏。

Toast / Tooltip / HoverCard 故意保持不透明：它们是浮在文字上的瞬时提示，透明只会掉可读性。

## 几个刻意的取舍

- **选择器是 `html body…` 而不是 `body…`**：调色板定义在 `body`（深色在 `body[data-ds-dark-theme]`）而且引导样式排在应用样式表**之前**，多一个元素正好靠特异性赢，不必用 `!important` —— 用 `!important` 会连第三方主题通过 `ctx.theme` 写的内联 token 一起压掉。
- **深色靠属性，不靠媒体查询**：DSH 客户端里没有任何 `prefers-color-scheme` CSS，只有 `body[data-ds-dark-theme]`，所以这里是成对的两条规则。
- **本地图片走 `/custom-background/image` 专用路由**，每次请求重新读文件，换图不必改 profile；用 `cache-control: no-store` 避免旧的壁纸被缓存。`/plugins/<id>/` 那条路由只服务 JS chunk，不能直接放图片（Electron 桌面版上它甚至不存在，bundle 走 `dsh-app://` + IPC）。
- **两条投递通路**，因为没有哪一条覆盖所有载体：宿主渲染 index 时注入 `<style id="dsh-custom-background-boot">` + 一行 `global` 数据（首帧不闪）；同一份样式表也挂在 `/custom-background/background.css` 上，浏览器半在没有引导数据时 `fetch` 它。实测 Electron 桌面版只在自有 web server 上应答插件路由，所以这条兜底是桌面版能生效的关键。
- **图片路径写错不会拖垮启动**：记一条警告然后什么都不做；`enabled: true` 但 `image` 为空时同样只警告、不绘制（便于确认宿主半确实加载了）。

## 已知限制

- `--dsw-hovercard-bg` 是 DSH 里唯一写死的不透明字面量（`#2C2C2E`，定义在组件自己的规则里），要覆盖它只能命中构建期哈希类名 —— 本插件不这么做。
- 第三方主题若通过 `ctx.theme` 注册 token 覆盖，那些内联值优先于本插件的玻璃 token（内联 > 样式表）；这是有意的：主题优先级更高。
- 只在 **web 客户端**（`dsh web` / 桌面壳 / 浏览器）生效；TUI、headless 不受影响。
- Windows Electron 桌面版的 `data-windows-titlebar` 形态下，框架底色与顶栏带用的是 `--dsw-specific-sidebar-fill`，已包含在上表里；普通 Web 页面没有这个标记。
- 大面积固定壁纸 + 模糊在低端机上有绘制成本；建议壁纸先压到 2560px 以内。

## 测试

```bash
npm test        # 33 项离线检查：配置钳制、路径解析、生成的 CSS、apply 契约、表单写入、版本化 URL
```

像素效果、真实加载路径需要跑一次 GUI 才算验过。

## 发布

发布走 GitHub Actions 的 **npm Trusted Publishing（OIDC）**，不需要任何 secret，与 `dsh-usage-badge` / `dsh-web-search-searxng` 一致。`.github/workflows/publish.yml` 的注释里写了每一步的用意。

首次发布前，两件事各做一次：

1. 把仓库推到 GitHub（`ai-written/dsh-custom-background`，`package.json` 的 `repository` 已按这个写）；
2. 在 npm 上配置 Trusted Publisher：包页面 → Settings → Trusted Publisher → GitHub Actions，填 owner `ai-written`、repo `dsh-custom-background`、workflow `publish.yml`（包里还没有对应版本时，可以从 npm 的 "Publish a new package" 流程里先建好这个名字再配）。

之后每次发版：

```bash
# 1) 改 package.json 的 version，提交
# 2) 打 tag 并推上去 —— tag 与 version 不一致时 CI 会直接失败
git tag v0.1.0 && git push origin dev v0.1.0
```

CI 会先跑 `npm test` 与 `npm pack --dry-run`，再由 OIDC 取凭据 `npm publish --access public`（provenance 自动附带）。只想预演的话，在 Actions 里手动触发 `publish` 并勾上 dry-run。

本地手工发布也可以（`prepublishOnly` 会先跑测试）：

```bash
npm login
npm publish --access public
```

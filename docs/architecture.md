# 运行与实现逻辑

这份文档讲**插件在 Zotero 里到底怎么跑起来的**：从 Zotero 加载它，到侧栏出现一个 ↗ 按钮，
再到那条注释落进思源日记、并且能从 PDF 点回思源。它也写下几条"改代码时不能破坏的约定"。

> 代码位置：`src/index.js` 是装配点，行为在 `src/app/`，可独立测试的模块在 `src/modules/`。

---

## 1. 加载：从 XPI 到插件对象

```
Zotero 启动
  └─ bootstrap.js  startup()
       ├─ registerChrome()           把 content/ 注册成 chrome://zoteroSiYuan
       ├─ loadSubScript(bundle, ctx) 在插件沙箱里执行打包后的脚本
       │    ├─ 各模块顶层的 import 依次求值
       │    ├─ new ZoteroSiYuanAddon()      ← 构造：只初始化状态
       │    └─ Zotero.ZoteroSiYuan = addon  ← Zotero 从此只认这一个对象
       └─ await hooks.onStartup()    真正的启动逻辑
```

**构造阶段只做两件事**：把状态字段摆好（索引、缓存、WeakMap、各种 set），以及把两个
Reader 事件处理器 `bind(this)`——Zotero 派发事件时 `this` 不是插件实例，不绑定就会丢。

**打包进去的是一个对象，不是一堆对象。** `src/app/` 的每个模块导出的是方法集合，
`index.js` 用 `Object.assign(ZoteroSiYuanAddon.prototype, ...)` 把它们装进同一个原型：

```js
Object.assign(
  ZoteroSiYuanAddon.prototype,
  content, diagnosticsApi, lookup, preferencesApi,
  readerMarks, readerUi, send, transport,
);
```

好处是 Zotero 侧的契约（一个实例、一套生命周期）不变，而写代码时按功能翻文件。

---

## 2. 启动时做什么（以及刻意不做什么）

| 做 | 为什么 |
|---|---|
| `initLocale()` 选语言包 | 按钮文字、toast 文案都靠它 |
| 注册偏好面板（6 个脚本） | 面板是一个对象拆在 6 个文件里，顺序即加载顺序 |
| 注册 `renderSidebarAnnotationHeader` | 按钮注入的唯一入口 |
| 注册 `createAnnotationContextMenu` | 批量发送的入口 |
| `_startSidebarWatcher()` | 补上"插件醒来前就已经画好的侧栏" |
| 可选自检 / 可选协议静默 | 都由偏好开关控制，默认关 |

**不做的两件事**都是有意的：

- **不 spawn `siyuan --version`**。解析 CLI 要跑一个进程，而第一次发送或第一次"测试连接"时才真正需要它。
- **不扫库建索引**。全量扫描是 `markdown LIKE '%zotero://…%'`，前置 `%` 用不上索引；
  改成按 PDF 增量（见第 5 节）。

启动代价因此接近零：注册两个事件 + 一个 2 秒轮询的定时器。

---

## 3. 按钮是怎么进到侧栏的

Zotero 的 PDF 阅读器每画一条注释的 header，就派发一次
`renderSidebarAnnotationHeader`，负载是 `{ doc, params, reader, append }`。

```
reader 画注释 header
  └─ 事件 → _onRenderSidebarAnnotationHeader(event)
       ├─ _ensureDelegation(doc)           每个 document 只挂一个 click 委托
       ├─ 记住 doc（context menu 事件不带 doc，批量发送要靠它）
       ├─ _createButton(...)               按钮：思源图标 + aria-label
       ├─ 索引里有这条注释？→ _dropManualLinks + _createSentLink  ← 已发送的 ↗
       ├─ event.append(button, link?)      ★ 必须同步，且只调一次
       └─ _ensureAttachmentIndexed(...)    后台把这个 PDF 的块读进索引
```

### 三条硬约束

1. **`append` 必须同步**，在这个 handler 返回之前调用——阅读器不等 Promise。
2. **只能调一次**。阅读器把每次 `append()` 包进自己的 box，按钮和 ↗ 分两次调用就会
   落在两个 box 里，谁也看不见谁，侧栏于是显示两个标记。
3. **box 会被阅读器整体重绘**。重绘时插件会再收到一次同一个事件，所以手工塞进去的标记
   带 `data-zsi-manual`，重绘前先摘掉，避免"两个 ↗"。

### 插件醒来时侧栏已经画好了？

`_startSidebarWatcher()` 补的只是**插件醒来之前就画好**的侧栏——其它侧栏都是插件在听的
时候画的，reader 自己会把事件递过来。所以这个 watcher 有天然的终点：

- **一个阅读器都没有就根本不启动**。没有 sidecar 要补，之后打开的阅读器都会自己递事件。
- 第一次看**不在启动路径上**（`WATCH_FIRST_DELAY` 1.2 秒后才跑）。它一跑就可能要 spawn
  一次索引查询，不能让一个进程挡在窗口绘制前面。
- 间隔从 1 秒涨到 5 秒（×1.6 退避），不是固定 2 秒。
- **一旦每个能看见的 reader 都处理完、没有还在加载的，就停**（`WATCH_MIN_TICKS` 3 次
  起步，覆盖"会话还在恢复"的那几秒）；读者关光了也立刻停。
- 上限 45 秒（`WATCH_WINDOW_MS`），而且只会在"某个 reader 一直在加载"时用到——加载完
  之后阅读器会自己递渲染事件，所以这个上限是保险，不是工作窗口。

**没有注释的 reader 不算 pending**：它现在没东西可补，以后加了注释会让阅读器重绘侧栏，
那次重绘插件听得见。把它算成 pending 只会让 watcher 空转到上限。

找 `.custom-sections` 里带 `.preview` 的盒子（工具栏也有 box，但它的 `.preview` 里没有
`page_<key>`），补上按钮和标记。看过渲染事件（`_renderedDocs`）的文档直接跳过，不做
无谓的 DOM 查询。

---

## 4. 一次发送：完整流水线

```
点击按钮 → _send(annotation, reader, button)
   ├─ _takeSendHooks()                自检的钩子只作用于它自己那次点击
   ├─ this._sending 已置位？→ 提示"发送中"
   ├─ _sendAnnotation(...)
   │    ├─ _resolveNotebook()          先定笔记本：这一步失败时还没写任何图片
   │    ├─ _buildContent(...)          ← 见下
   │    ├─ _append(notebookID, md)     CLI 写日记，失败走 HTTP
   │    ├─ 索引 add(annotationKey → blockID)
   │    └─ 返回 { transport, blockID, notebook, markdown }
   ├─ _flash(按钮,"已发送") + toast（带"在思源中打开"）
   └─ _updateRenderedMarkers(doc)      不用重开 PDF，↗ 立刻出现
```

顺序是**笔记本在前、图片在后**：图片一旦落进 workspace 就属于那个 workspace，而笔记本是在
`_append` 时才确定的。先定笔记本，解析失败就什么也没写，不会留下一张孤儿图片。

### `_buildContent` 里发生了什么

```
_getAttachment(reader)        正在看的这个 PDF（一次查询，下面还要用它）
_getParentItem(reader, hooks, attachment)
                              文献条目（作者/年份/出处都在它身上）
_resolveAnnotationKey(...)    注释 key（索引的主键）
_preparePicture(annotation, key)
                              框选注释才有：把图放进 workspace，返回 Markdown
collectMetadata({...})        拍平成模板变量表
renderTemplate(模板, vars)    {{var}} / {{#if}} 渲染
appendPicture(text, image)    图片 Markdown 插到正文
```

### 一次写入要 spawn 几个进程

`siyuan` CLI 每次启动约 **0.6 秒**（实测 Windows / SiYuan 3.8.9），所以进程数就是延迟：

| 步骤 | 之前 | 现在 |
|---|---|---|
| `dailynote create` | 每次发送 | **每个「笔记本 + 当天」一次**（`dailyNoteDocument()` 记住；写失败会重建一次） |
| `block append` | 每次发送 | 每次发送（这一条给出真正的块 id，必须跑） |
| `sql`（写前/写后各一次，取差集） | 每次发送 | 只有自检要清理时才跑（`collectBlocks`） |
| **合计** | **3 次 ≈ 1.8 秒** | **1 次 ≈ 0.65 秒** |

批量发送是逐条串行的（顺序即日记里的顺序），所以 20 条注释从约 37 秒降到约 13 秒。

### 失败时最重要的三件事

1. **写没写进去，不能靠猜。** CLI 进程已经启动、但答案没读到（超时、stdout 坏掉）时，这条
   命令**可能已经写进去了**。这种结果记成 `writeState: "unknown"`，从此**不许重跑**——既不
   能再走 HTTP 兜底（会写第二条），也不能删掉图片（那条笔记正引用它）。
2. **图片要收回去——只在确定没写的时候。** 框选注释的图片在正文写进思源**之前**就已经落进
   `data/assets`。确定失败（进程根本没起来、内核明确拒绝）才 `_dropPicture()`；结果未知时
   保留图片，留给用户自己判断。
3. **两个通道的错都要报。** CLI 失败不一定意味着没写成，所以两种传输的错误串在一条消息里
   给用户，而不是只留最后一条。

### 批量发送

右键注释 → `createAnnotationContextMenu` → `_sendMany(ids, reader, doc)`：逐条走同一个
`_sendAnnotation`，一条失败不影响其余，最后用一个 toast 报"N 条成功 / M 条失败"，
并把所有 ↗ 一次性补到屏幕上。

失败不是只给个数字：气泡里列出前几条的 key 和原因，并提供"重试失败的那几条"。整个批量
（包括进度气泡本身）在 `try/finally` 里，所以阅读器被关掉、气泡画不出来时，`_sending`
仍然会释放——否则之后每次发送都只会得到"正在发送"。

注释 item 用 `_prefetchAnnotationItems` 后台并发读取，循环里按顺序取答案：批量不会为每条
注释串行等一次库读取。

---

## 5. 索引与回链：为什么不用标签

"这条注释发到哪个块"这个映射**只存在思源里**。每条写入的笔记正文都带一个 Zotero 深链：

```
[标题](zotero://open/library/items/<附件 key>?annotation=<注释 key>&page=3)         个人库
[标题](zotero://open/groups/<群组 id>/items/<附件 key>?annotation=<注释 key>&page=3) 群组库
```

群组库是**另一条路径**：同样的 key 在群组里是另一个条目，写成个人库那条路径时 Zotero 不会
报错，它只是在自己的库里找不到、链接什么都不做。所以 `libraryPath(libraryID)` 决定用哪条。

插件反着读回来：`SELECT id, markdown FROM blocks WHERE markdown LIKE '%zotero://open/%/items/%'`，
用 `annotation=` 后面的 key 建 `Map<注释 key, 块 id>`。`LIKE` 不能只认个人库的前缀——
那样群组库发出来的笔记对索引而言等于不存在，重启后标记就没了。

- **不写进 Zotero 库**：标签会出现在标签选择器里、同步到服务器、共享库的其他人也看得见，
  而且它终究不是链接。
- **按 PDF 增量**：`_ensureAttachmentIndexed` 只查这一个附件；侧栏渲染时后台跑，答完就补 ↗。
- **防覆盖**：每添加一条就记一个 revision；扫描开始时的 revision 之前/之后的写入不会被
  旧查询结果冲掉（`refresh` / `refreshForAttachment` 里的 `_revisions`）。
- **既没父条目也没关系**：`collectMetadata` 退回用附件本身的元数据（标题、`itemKey`），
  否则单独拖进文库的 PDF 会写成一条没有标题、也没有回链的笔记，重启后永远找不回来。
- **回链**：`siyuan://blocks/<id>`。优先自己拉起思源（`siyuan-launcher.js`），
  失败再交给系统协议处理器。

---

## 6. 框选注释的图片

```
isPictureAnnotation(annotation)       type 是 image / ink 才有图
   ├─ 源 1：Zotero 缓存文件           annotationImagePath(item) ← 必须 await
   └─ 源 2：reader 给的 data URL      annotationImageDataURL(annotation)
exportPicture(workspace, source)     写到 <workspace>/data/assets/zotero-siyuan-<key>-<ts>.<ext>
   ├─ 压缩（可选）                    只有变小才用；扩展名按字节嗅探，不硬编码 .png
   └─ 记账 this._pendingPicture        发送失败要能收回去
pictureMarkdown(assetPath, alt)      生成 ![](assets/…) 插入正文
```

**图片丢了不能连正文一起丢**：找不到图只是没有图，注释和评论照发。

---

## 7. 模板引擎

- `{{变量}}`、`{{#if 变量}}…{{else}}…{{/if}}`（可嵌套），空值整行裁掉（`dropEmptyLines`）。
- `validateTemplate()` 返回 `unknown / unbalanced / strayClose`：未知变量、少写的 `{{/if}}`、
  多写的 `{{/if}}` 分开报，不会把"多余"说成"未闭合"。
- 变量表 `TEMPLATE_VARIABLES` + 预设 `TEMPLATE_PRESETS` 同时喂给设置页的提示与预览。
- 设置页在光标处插入变量/条件（`template-edit.js`），并把选区包进条件里。

**用户保存的模板**（`template-store.js`，纯函数，不碰 Zotero）：

```
偏好 templates = [{ id, name, template }, …]（JSON 字符串，上限 50）
   saveTemplate( shelf, { id?, name?, template? } )
     id 命中          → 更新那一份（给了名字就顺便改名）
     名字命中          → 更新同名的那一份（不会堆出副本）
     都没有            → 新建一份，追加到末尾
   空模板 / 没名字 / 满了 → 返回 error，让面板把原因说给用户听
```

- `parseSavedTemplates()` 对一切手改坏的偏好都返回空列表：非法 JSON、不是数组、
  缺 `template`、缺 `id`（补一个）、`id` 重复（第二个换一个）—— 面板不会因为一个
  偏好打不开。
- 面板侧：下拉列表 + 名字框 + 保存/套用/删除；**删除按两次**（`_deleteArm`），
  换一份就把待删状态收回去；列表为空时「套用」「删除」置灰。
- 自检（`ui: true`）真的存一份、套回来、删掉，最后把 `templates` 偏好原样写回。

---

## 8. 传输层：两个通道，一个接口

```
SiYuanProcess          找可执行文件、试路径、跑进程、超时、读懂输出
   └─ SiYuanCLI        业务：notebook list / dailynote create / block append / sql / delete
SiYuanHTTP             直接打内核 API（读 conf.json 拿 token 和端口，自动发现）
```

写日记的首选路径是**两条命令**，因为只有第二条才回答真正的块 id：

```
siyuan dailynote create --notebook <id>        → 日记文档 id
siyuan block append --parent <文档 id> --file <md>  → { "id": "<块 id>" }
```

旧版 CLI 没有 `block append`，才退回 `dailynote append`（它只回文档 id，块 id 靠 `created`
秒去查）。**注意**：如果命令超时或"可能已经写了"，一律不退回重试，否则会写两遍。

---

## 9. 自检：用插件自己的代码路径证明它能用

自检不 mock 任何东西，走的就是用户点击的路径：

```
renderSidebarAnnotationHeader 事件 → 真按钮 → 真 click() → _send → 渲染 → 解析笔记本 → 写思源
```

- **钩子机制**：`watchNextSend(hooks)` 把钩子放在 `_pendingSendHooks`，`_send` **同步**
  取走——所以钩子只作用于它自己那次点击；真实点击不带钩子，永远不受影响。
- **两种模式**：dry run（`--dry-run`，思源校验命令但不落盘）与 real write（真写，事后删块）。
- **步骤分文件**：`steps/markers.js`、`steps/note.js`、`steps/readers.js`，都接收同一个
  `ctx`（addon、report、captured、clickAndWatch…），通过/失败由 `step()` 统一判定。
- **清理**：`pictures.js` 记住这次写出去的图片（按名字，以及"前后对比 assets 目录"两种方式），
  结束时全部收回；real write 模式删掉自己写的所有块，并把屏幕上的 ↗ 改回正确目标。

---

## 10. 设置页：一个对象，六个脚本

Zotero 把 `scripts` 数组里的文件**按顺序加载进同一个面板作用域**：

| 文件 | 职责 |
|---|---|
| `preferences.js` | 建对象：元素 id、常量、状态、`init()`、共享工具 |
| `preferences-template.js` | 模板编辑器、预览、预设、条件插入、我的模板 |
| `preferences-variables.js` | 变量列表、筛选、条件变量选择 |
| `preferences-pictures.js` | 图片压缩设置、框选检查 |
| `preferences-actions.js` | 测试连接、重扫索引、自检 |
| `preferences-boot.js` | **最后**加载，调用 `init()` |

顺序错了面板就是空的，`tools/validate/00-layout.mjs` 会核对这份顺序。

---

## 11. 改代码时别破坏的约定

1. `event.append(...)` **同步、一次**——分两次会让按钮和标记落进两个 box。
2. `imagePath` 必须是**字符串**：`annotationImagePath()` 是 async，忘了 `await` 会得到一个
   恒为真的 Promise，图片静默丢失。
3. 图片**先落盘、后记账**：任何一步失败都要 `_dropPicture()`。
4. 索引以**思源**为准，扫描结果不能覆盖扫描期间新加的条目（revision）。
5. 同一时间只允许一次发送（`_sending`）。
6. 自检**不得改变**真实发送的行为：钩子只挂一次、只被一次点击取走。
7. 面板脚本的顺序 = 注册顺序，boot 必须最后。
8. 插件对象只有一个（`Zotero.ZoteroSiYuan`），`app/` 的新模块必须 `Object.assign` 进原型。
9. **一次发送最多 spawn 一个进程**（`block append`）。任何"顺手查一下"的 CLI 调用都要先想
   清楚它是不是每次发送都必要——一次 0.6 秒，批量发送里是乘上去的。
10. **侧栏每次渲染 header 的代码不能做全文档查询**。一个 PDF 几百条注释，一次渲染就是
    几百次查询；手动标记走 `_manualLinksOf` 的 `WeakMap`，不要退回 `querySelectorAll`。
11. **异步调用必须 `await`**。`IOUtils.exists()` / `Zotero.Items.getAsync()` 这类返回的是
    promise，而 promise 恒为真——`if (IOUtils.exists(x))` 什么都检查不到。`npm run check`
    里有一条 `Async calls are awaited` 专门扫这个（注释和字符串会先被剥掉）。
12. **模板变量不能是"永远是空"的**。`{{annotatorDate}}` 曾经如此：Zotero 给阅读器的注释
    JSON 里**没有日期**，而这个变量正是从那里取的。现在它从条目取，且只在模板真的用到时
    才查一次条目（`_templateUses`，按模板字符串缓存）。
13. **索引扫描一次会话只跑一次**（`ensureScanned` + `INDEX_TTL_MS`）。`LIKE '%…%'` 本来
    就要读整张表，按 PDF 分片省不下扫描量，只是把同样的活儿做了 N 遍——实测（1341 行的
    表）整表查询 4–6 ms、单个 PDF 3–5 ms，而两者各要 spawn 一次进程。并发的侧栏必须等
    同一个 Promise（`_scanning`），否则恢复八个标签页就是八次全表查询。
14. **发送期间所有按钮都置灰**（`_setReaderBusy`），而且在发送中途渲染出来的 header 也要
    一出生就是 disabled（`_busyDocs`）。只禁用被点的那一个，等于允许"再点一下"写第二条。
15. **气泡画在调用方给的文档里**（`showToast({ doc })`）。跨窗口投递在阅读器占满窗口时
    等于没显示；每个文档一个 stack（`WeakMap`），不要退回到"全局一个容器"。
16. **索引属于一个 workspace**（`ensureScanned({ key })`）。“这条注释发过”这个映射只存在
    于某个 workspace 里，换 workspace 之后旧索引里的标记全是死链，所以 key 变了就先清空。
17. **"这个 PDF 索引过了"只在一定时间内成立**（`_indexedAttachments` + `INDEX_TTL_MS`）。
    原来记一次就永远跳过，于是思源里新增/删除/同步进来的笔记永远不会反映到侧栏。
18. **索引也能走 HTTP**（`_indexTransport` + `POST /api/query/sql`）。CLI 起不来但内核能
    连上时，发送是好的，可重启后所有标记消失——只因为扫描只会用 CLI。

---

## 12. 已知的取舍

- 索引的查询是 `LIKE '%…%'`，数据库大时单次会慢——但它**不是每次侧栏都跑**
  （`INDEX_TTL_MS` 5 分钟，`ensureScanned`），期间所有 PDF 都从这一次结果里回答。
  并发的侧栏会等同一个 Promise，不会各起一次。整表扫描失败时才退回"这个 PDF 单独查"。
  代价是思源里外部改动最多要 5 分钟才出现在侧栏，且换 workspace 或到点之后会重扫一次。
- 手动标记（`data-zsi-manual`）按文档建了 `WeakMap`，每个文档只扫一次 DOM；代价是插件
  被重载后由**旧实例**插入的标记要靠那次扫描找回来——扫描用 `isConnected` 兜底，找不到
  就当它已经被 reader 擦掉了。
- 批量发送仍是**串行**的：一次发送一个进程（约 0.65 秒），两条同时写会抢同一篇日记。
  所以 12 条注释大约要 8 秒——这期间气泡显示进度，阅读器里所有发送按钮置灰。
- 压缩后的图片在内存里留一份（最多 12 张 / 32 MB），所以"同一张图再发一次"不必重新
  解码 + 重编码。代价是插件退出前占着这些内存（`forgetPictures()` 在 `onShutdown` 里清）。
- 预览气泡显示在**调用方给的文档**里（阅读器发送就弹在阅读器里）；如果那次发送来自
  一个即将关闭的标签页，气泡会跟着那个文档一起消失——这是不要跨窗口投递的代价。

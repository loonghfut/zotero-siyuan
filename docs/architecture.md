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
  content, destination, diagnosticsApi, itemMenu, itemSend, lookup,
  preferencesApi, readerMarks, readerUi, send, sendBatch, sentCache,
  autoSend, transport,
);
```

好处是 Zotero 侧的契约（一个实例、一套生命周期）不变，而写代码时按功能翻文件。

---

## 2. 启动时做什么（以及刻意不做什么）

| 做 | 为什么 |
|---|---|
| `initLocale()` 选语言包 | 按钮文字、toast 文案都靠它 |
| `_loadSentCache()` | 思源没开时侧栏仍然能显示 ↗（见 5.1 节） |
| `_registerAutoSend()` | 监听新建注释；自动发送关着时 `notify` 直接返回，不做事 |
| 注册偏好面板（7 个脚本） | 面板是一个对象拆在 7 个文件里，顺序即加载顺序 |
| 注册 `renderSidebarAnnotationHeader` | 按钮注入的唯一入口 |
| 注册 `createAnnotationContextMenu` | 批量发送的入口 |
| `_startSidebarWatcher()` | 补上"插件醒来前就已经画好的侧栏" |
| `installItemMenus()` | 补上"插件醒来前就已经开着的窗口"——见下一段 |
| 可选自检 / 可选协议静默 | 都由偏好开关控制，默认关 |

`onStartup` 里还按 `autoSend` 决定要不要在 8 秒后跑一轮待发队列。

条目列表右键菜单在 `onMainWindowLoad({ window })` 里装、`onMainWindowUnload` / `onShutdown`
里拆。但 Zotero 只在窗口**打开**时调 `onMainWindowLoad`（`xpcom/plugins.js` 的
`onOpenWindow`），而插件是在 `Plugins.init()` 里启动的——**在 Zotero 运行中安装或重新启用
插件时，已经开着的那个主窗口永远收不到这个回调**。所以 `onStartup` 末尾还会用
`Zotero.getMainWindows()` 把菜单装进现有窗口；窗口还没加载完（没有 `#zotero-itemmenu`）
就等它的 `load`。两条路都是幂等的（按 `MENU_ID` 查重）。

**不做的两件事**都是有意的：

- **不 spawn `siyuan --version`**。解析 CLI 要跑一个进程，而第一次发送或第一次"测试连接"时才真正需要它。
- **不扫库建索引**。全量扫描是 `markdown LIKE '%zotero://…%' OR ial LIKE '%custom-zotero-annotation-key=%'`，前置 `%` 用不上索引；
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
   ├─ 已发送检查（_index.getEntry）   ask / skip / send / replace，见第 4.5 节
   ├─ _sendAnnotation(...)
   │    ├─ _resolveNotebook()          先定笔记本：这一步失败时还没写任何图片
   │    │                             （固定文档目标不需要笔记本）
   │    ├─ getTemplateFor(kind)        item 用单独模板，空则用通用模板
   │    ├─ _buildVars(...)             图片落盘 + 模板变量
   │    ├─ _resolveDestination(...)    日记 / 指定文档 / 每篇文献一篇
   │    ├─ _buildContent(..., {vars})  渲染模板
   │    ├─ _append(notebookID, md, …)  CLI 写目标文档，失败走 HTTP
   │    ├─ 索引 add(annotationKey → blockID, details)
   │    └─ 返回 { transport, blockID, notebook, documentID, markdown }
   ├─ _flash(按钮,"已发送") + toast（带"在思源中打开"）
   └─ _updateRenderedMarkers(doc)      不用重开 PDF，↗ 立刻出现
```

顺序是**位置在前、图片在后**：图片一旦落进 workspace 就属于那个 workspace，而写进哪个文档要先
解析成功。先定位置，解析失败就什么也没写，不会留下一张孤儿图片。

### 正文是怎么来的

```
_getAttachment(reader)        正在看的这个 PDF（一次查询，下面还要用它）
_getParentItem(reader, hooks, attachment)
                              文献条目（作者/年份/出处都在它身上）
_resolveAnnotationKey(...)    注释 key（索引的主键）
_preparePicture(annotation, key)
                              框选注释才有：把图放进 workspace，返回 Markdown
collectMetadata({...})        拍平成模板变量表            ← _buildVars
renderTemplate(模板, vars)    {{var}} / {{#if}} 渲染
appendPicture(text, image)    图片 Markdown 插到正文        ← _buildContent
```

变量先收集、后渲染：目标位置（「每篇文献一个文档」的标题）也要用同一份变量，两边不能各算一次。

### 一次写入要 spawn 几个进程

`siyuan` CLI 每次启动约 **0.6 秒**（实测 Windows / SiYuan 3.8.9），所以进程数就是延迟：

| 步骤 | 单条发送 | 批量发送（N 条） |
|---|---|---|
| `dailynote create` | **每个「笔记本 + 当天」一次**（`dailyNoteDocument()` 记住；写失败会重建一次） | 一次 |
| `block append` | 每次发送一次（这一条给出真正的块 id，必须跑） | **一次**（整批合并） |
| `sql`（写前/写后各一次，取差集） | 只有自检要清理时才跑（`collectBlocks`） | 一次（分组要用块行） |
| **合计** | **≈ 1 次进程** | **≈ 2 次进程**（不再乘 N） |

批量写入的上限不再是 N 个进程，而是一次 `block append`。每条笔记整体包成一个**超级块**
（`{{{row … }}}`），注释 key 以块 IAL 挂在容器上，所以写入后一块对一条，分组是精确的。
旧版笔记没有超级块，仍按末尾不可见的零宽链接（`zsi=batch`）在 `sort` 顺序里切分；
重启后替换旧笔记时按同样的锚点找回边界，不会把整批都删掉。

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

右键注释 → `createAnnotationContextMenu` → `_sendMany(ids, reader, doc)`。

和单条走同一套渲染，但**只写一次**：

1. 逐条解析注释、读条目（`_prefetchAnnotationItems` 后台并发读），已发送的按偏好跳过并计数；
2. 每条调用 `_buildVars` + `_buildContent`，然后 `markBlock` 包成超级块、
   属性挂在容器上（`block-attrs.js`）；
3. 解析一次目标位置（「每篇文献一个文档」下所有注释属于同一篇文献，所以是同一个文档）；
4. 所有正文用 `\n\n` 连起来，走一次 `_append(..., { collectBlocks: true })`；
5. 写入返回的顶层块按 `sort` 排序；每块的 `ial` 里有注释 key 的，一块归一条，
   且**每一行都能对上号**才接受这份映射（对不上就退回锚点路径）；每组的块 id 和
   Markdown 都记进索引；
6. 需要「替换上次」的，在新写入成功之后再删旧块，旧的 ↗ 标记先摘掉。

失败不是只给个数字：气泡里列出前几条的 key 和原因，并提供"重试失败的那几条"和"全部重试"
（后者用 `allKeys` 把整批再发一遍，已写入的按 `sentAction` 跳过）。整个批量
（包括进度气泡本身）在 `try/finally` 里，所以阅读器被关掉、气泡画不出来时，`_sending`
仍然会释放——否则之后每次发送都只会得到"正在发送"。

一张图片只在建它那条笔记时落盘；整批写失败（且不是 `writeState: "unknown"`）时，
`_batchPictures` 里所有图片一起收回，而不是只收最后一张。

### 自动发送与待发队列

```
新建注释 → Notifier("item", "add") → _autoSendLater(1.2s)
            ├─ _maybeAutoSend：isAnnotation？过滤器？索引里已有？_sending 忙？
            ├─ _sendAnnotation(..., { auto: true })
            └─ 失败分类：
                 writeState=unknown → 只记日志（可能已写，重发会写两条）
                 error.permanent    → 只记日志（目标文档不存在等，重发没用）
                 其它               → _queueFailed → pendingQueue 偏好
```

- **默认关闭**：`autoSend = "0"`；关闭时 notifier 仍然注册，但 `notify` 第一行就返回，
  队列重试也暂停（`_scheduleQueueRetry` 直接返回）。
- **过滤是"与"**（`modules/auto-filter.js`）：颜色、标签、注释类型、条目分类四个维度，
  每个维度为空 = 这一项不限；全部为空才会发所有新注释。条目分类取的是**文献条目**——
  注释的父项是 PDF 附件，所以 `_annotationItemType` 往上走两级。
- **待发队列**（`modules/pending-queue.js`，纯函数）：`[{ key, attempts, at }]`，
  最多 200 条；`failPending` 只加尝试次数，退避从 60 秒翻倍到 30 分钟（上限）。
  触发点有三个：启动 8 秒后、任意一次发送成功之后（`_retryPendingQueueSoon`）、面板按钮。
- 队列只存 **key**，重试时重新渲染：注释还在 Zotero 里，拿旧 Markdown 重发反而会写进
  已经变了的内容。

### 条目级发送

`item-menu.js` 在主窗口的 `#zotero-itemmenu` 里追加一个 XUL `<menu>`（`popupshowing`
时按"有没有选中普通条目"决定隐藏）。五个入口分别在 `item-send.js`：

| 方法 | 内容 |
|---|---|
| `_sendItemInfo` | `itemInfoMarkdown(vars, itemInfoTemplate)` |
| `_sendItemAbstract` | `abstractMarkdown(vars, abstract, itemAbstractTemplate)` |
| `_sendItemNotes` | 子笔记 HTML → Markdown（`noteHtmlToMarkdown`），按 `itemNotesTemplate` 逐条渲染 |
| `_sendItemAnnotations` | 汇总各 PDF 的注释 key，交给 `_sendMany`（和阅读器批量同一条路） |
| `_syncItemDocument` | 固定走 `_resolveItemDocument`，把信息/摘要/笔记写进这篇文献的文档，随后增量同步注释 |

前四个入口在 `app/item-actions.js`，写入本身仍在 `_sendItemMarkdown`。

`_sendItemMarkdown` 按 `destination` 决定写哪里：`item`（或 `itemDocument: true`）用
`_resolveItemDocument`，`document` 不需要笔记本，其余用 `_resolveDestination`。

条目级写入（`_sendItemMarkdown`）先 `markBlock` 包成超级块；「同步这篇文献」的那块带
`custom-zsi-section="item"` 和 `custom-zsi-item-key`。同步时先按 item key 查出旧块
（旧版写出的三段也带这个 key），**新块写成功之后**再删旧块；只删带这个属性的块，所以
用户自己加的内容和注释笔记（带 `custom-zotero-*`）不受影响。旧块靠思源里的属性找回，
不依赖 Zotero 状态，换机器也能继续替换。

「发送条目信息 / 摘要 / 笔记」写的是 `custom-zsi-section="info|abstract|notes"` 的
独立区段（`itemSectionAttributes`）。同步会**接管**这些块：`_soloItemSectionBlocks`
按 `custom-zotero-item-key` + 三个区段名把它们查出来，和不带 section 的容器一起替换。
没有这一步时，先后点单独发送和同步会在同一篇文档里留下两份信息/摘要/笔记。接管只按
属性识别，用户手写的内容没有这些属性，仍然不动。

条目级写入不经过 `_sendAnnotation`，所以不参与"已发送"检查、不建立注释索引——
它送的是整条文献，不是某条注释。

#### 原地更新（`app/block-update.js`）

旧块只有一个时，同步不再"写新的、删旧的"，而是 `_updateBlock` 原地改写：块 ID 不变，
指向它的链接、反向链接和索引记录都还成立，也没有"两份都在"的中间态。CLI 走
`block update --id … --file … --format json`，HTTP 走 `/api/block/updateBlock`；
两者都拒绝时才退回先写后删（`_replaceItemSection` 返回 `{updated:false, gone:false}`）。
写不成功但**可能已经落盘**的（`isWriteUnknown`）直接抛出，不换传输重试，免得写两遍。

思源的查询索引比写入慢一拍，所以"块没了"要问两次：`_blockRow` 第一次查不到时等
1000 ms 再查，只有两次都没有才认定块已消失。解析器重建块时可能丢掉 IAL，
`_setBlockAttrs` 会把缺的属性补回去——下一次同步正是靠这些属性找到它。

#### 区段模板

信息、摘要、笔记各有一个模板偏好（`itemInfoTemplate` / `itemAbstractTemplate` /
`itemNotesTemplate`），空字符串表示用 `item-note.js` 里的内置写法。渲染入口是
`item-sections.js` 的 `_itemSectionMarkdown(vars, notes)`，它把三个偏好分别交给
`itemInfoMarkdown` / `abstractMarkdown` / `notesMarkdown`。`notesMarkdown` 对**每条**
子笔记渲染一次，所以 `{{note}}`、`{{noteCallout}}`、`{{noteNumber}}` 是逐条的值。
`{{metadataCallout}}` / `{{abstractCallout}}` 只在有内容时才产生文本，内置模板用
`{{#if}}` 包住它们，条目缺摘要时就不会留下一个空 callout。

区段模板**不会替用户补正文**：模板里写了什么就写什么，没有正文变量就只写标题。
少了正文的问题在编辑模板时提示——`missingBodyVariable(slot, template)`（`item-note.js`）
认出笔记/摘要/信息各自需要的正文变量，`checkTemplate(template, slot)` 把它作为一条
problem 返回，设置页的「检查」区域直接显示出来（例如 “the body is missing — add
{{noteCallout}}”）。这比运行时悄悄补一段文字更可预期：模板是用户写的，位置也该由
用户决定。

区段模板和通用模板存的是同一套变量，`template.js` 的 `TEMPLATE_VARIABLES` 是唯一的
清单；设置页的「模板用途」在 `note` / `item` / `info` / `abstract` / `notes` 五者之间切换，
`template-store.js` 的 `TEMPLATE_SLOTS` 是与之一致的白名单。

#### 子笔记里的图片

Zotero 7 不把图片放在笔记 HTML 里：`<img>` 上只有 `data-attachment-key`，图片本身是
这条笔记下面的一个独立附件（`linkMode = 4`，`storage:image.png`）。旧版笔记则可能把
图片写成 `data:image/…` 的 data URL。两种都不是思源能直接打开的地址。

`_itemNotes` 因此先让 `app/item-pictures.js` 的 `_noteImageAssets` 把图片搬进
workspace。`modules/note-images.js` 只从 HTML 里认图片（`noteImageRefs`，同一张图只算
一次）；`_noteImageSource` 用笔记所在 library 的 `getByLibraryAndKeyAsync` +
`getFilePathAsync` 取文件，或者直接用 data URL；之后走的是和框选**同一条**
`exportPicture`（压缩设置也共用）。`rewriteNoteImages` 把 `src` 换成 `assets/…`，
再交给 `noteHtmlToMarkdown`——最后写进思源的就是普通的
`![](assets/zotero-siyuan-note-XXXX.png)`。

文件名**不带时间戳**：一次同步会重写整个笔记区段，带时间戳的话每同步一次就在 `assets`
里多一份副本；按附件 key（或 data URL 的摘要）命名，同一张图始终落在同一个文件上。

`_withItemPictures` 把「建图 + 写笔记」包成一段，并记在**自己的清单**上（注释同步在
写入过程中也会改 `_batchPictures`）：写成功就留下图片，写失败（且不是
`writeState: "unknown"`）就 `_dropPictures` 收回。图片找不到或放不进去只是少一张图，
笔记照写。

#### 注释的增量同步（`app/item-annotations.js`）

「同步这篇文献」写完信息/摘要/笔记后，在**同一个发送锁**里（`_sendItemMarkdown` 的
`followUp`，两半合成一个 promise 交给 `_trackInflight`）把注释也带进这篇文档。
每条注释仍是一个单独的超级块，走和阅读器批量写入一样的渲染与属性，所以 ↗ 标记、索引、
「打开」都照常工作；只是多带两个属性：`custom-zsi-section="annotations"` 和
`custom-zsi-template`（模板指纹）。

| 情况 | 处理 |
|---|---|
| 以前没写过 | 追加，并从这次写入返回的 `blockRows` 里读出块 ID 记进索引 |
| `dateModified` 或模板指纹变了 | `_replaceItemSection` 原地改写，块 ID 不变 |
| 原地改写被拒 | 新块先写成功，旧块进 `stale`，写入完成后才删 |
| 注释已不在库里 | 只在写入都成功之后删它的块 |
| 没有变化 | 不渲染、不写入 |

列表查询只认 `custom-zsi-section="annotations"`，所以用户自己发进这篇文档的注释（带
`custom-zotero-*`）永远不会被同步删掉。新块的 ID 优先来自写入返回的 `blockRows`；
取不到时等 1200 ms 重新查一次（索引滞后），仍取不到也不算失败——下一次同步会找到它。
偏好 `itemSyncAnnotations = "0"` 关掉这一段，只写信息/摘要/笔记。

---

## 4.5 目标位置与"已经发过"

`destination.js` 只回答一个问题：**这次写到哪个文档**。

| 设置 | 解析方式 | 需要的命令行 |
|---|---|---|
| `daily` | 不变，交给 `dailynote create` + `block append` | 0（复用当天缓存） |
| `document` | 填块 ID 直接用；填标题先 `sql` 查 `type='d' AND content=…` | 0–1 次 |
| `item` | 先按 `custom-zotero-item-key` 找文档，找不到按标题找，再找不到 `document create` + `attr set` | 1–2 次 |

固定文档目标**不要求笔记本设置有效**：它有自己的文档 ID，`_resolveNotebook()` 根本不必跑。
「每篇文献一个文档」的标题用和正文同一份模板变量渲染，所以 `{{title}}` 和正文里指的是同一篇。

模板也按目的地分开：`item` 用 `itemTemplate`，它为空时回落到 `template`。选择发生在
`_buildVars` 之前（`getTemplateFor(kind)`），因为模板决定要不要为了 `{{annotatorDate}}`
去读条目；单条和批量都走同一条规则。设置页只有一支编辑框，顶部「模板用途」决定它在读写
哪一个偏好。

已发送检查发生在任何渲染/进程之前：`_index.getEntry(annotationKey)`。行为由偏好
`sentAction` 决定：

- `ask` —— 气泡里给「打开已有 / 仍然发送 / 替换上次」三个按钮；选择后重新进入 `_send`，
  但带上 `alreadySent`，不会再问第二次；
- `skip` —— 提示一下并返回；
- `send` / `replace` —— 直接继续。

`replace` 的顺序是**先写新、再删旧**：新笔记写失败时旧的原样保留；只有新块已经拿到，
才删旧块、删它带进来的 `zotero-siyuan-*` 图片、摘掉旧 ↗，再把索引指到新块。
批量里 `ask` 不会逐条弹窗，按 `skip` 处理并在汇总里报"跳过 N 条"。

---

## 5. 索引与回链：为什么不用标签

"这条注释发到哪个块"这个映射**只存在思源里**。每条写入的笔记正文都带一个 Zotero 深链：

```
[标题](zotero://open/library/items/<附件 key>?annotation=<注释 key>&page=3)         个人库
[标题](zotero://open/groups/<群组 id>/items/<附件 key>?annotation=<注释 key>&page=3) 群组库
```

群组库是**另一条路径**：同样的 key 在群组里是另一个条目，写成个人库那条路径时 Zotero 不会
报错，它只是在自己的库里找不到、链接什么都不做。所以 `libraryPath(libraryID)` 决定用哪条。

正文之外，每条笔记还包在一个**超级块**里，注释自己的属性（`block-attrs.js`）挂在
容器上：

```
custom-zotero-annotation-key / item-key / attachment-key / color / page / tags / modified
```

属性以块 IAL（`{: custom-x="y"}`）的形式写在**同一次 `block append`** 里（超级块的
`}}}` 之后一行），所以不多起进程。一次发送就是一个块：`block append` 返回的第一个块
= 超级块 = 整条笔记，索引、「在思源中打开」、「替换上次」都以它为单位。
它也把索引从模板里解放出来：模板完全不写 `{{zoteroAnnotationLink}}`，扫描仍然找得到这条笔记。
索引同时认两条线索：

```sql
SELECT id, markdown, type, root_id, ial FROM blocks
WHERE markdown LIKE '%zotero://open/%/items/%'
   OR ial LIKE '%custom-zotero-annotation-key=%'
```

`LIKE` 不能只认个人库的前缀——那样群组库发出来的笔记对索引而言等于不存在，重启后标记就没了。

- **不写进 Zotero 库**：标签会出现在标签选择器里、同步到服务器、共享库的其他人也看得见，
  而且它终究不是链接。
- **属性也属于“思源是唯一真相”**：换模板、换机器、重扫工作空间，属性都还在。
  值里的双引号/反斜杠会被换成空格 —— 思源在 IAL 里不把反斜杠当转义，一个引号会截断整行。
- **按 PDF 增量**：`_ensureAttachmentIndexed` 只查这一个附件；侧栏渲染时后台跑，答完就补 ↗。
- **防覆盖**：每添加一条就记一个 revision；扫描开始时的 revision 之前/之后的写入不会被
  旧查询结果冲掉（`refresh` / `refreshForAttachment` 里的 `_revisions`）。
- **既没父条目也没关系**：`collectMetadata` 退回用附件本身的元数据（标题、`itemKey`），
  否则单独拖进文库的 PDF 会写成一条没有标题、也没有回链的笔记，重启后永远找不回来。
- **回链**：`siyuan://blocks/<id>`。优先自己拉起思源（`siyuan-launcher.js`），
  失败再交给系统协议处理器。

### 5.1 本地副本，和"块被删了"

索引在内存里，读它需要 SiYuan 能扫。思源没启动时侧栏会把每条注释都当成没发过，
所以插件在 Zotero 偏好 `sentCache` 里留一份 `{ key, entries:[{annotationKey, blockID,
documentID, at}] }`：

```
启动 _loadSentCache()
   ├─ 缓存里的 workspace 和当前设置不同 → 整份丢弃
   ├─ _index.seed(entries)              先让 ↗ 出现，此时还没扫过思源
   └─ 第一次真正扫描 → SiYuanIndex.refresh() 发出 "snapshot"
        ├─ 仍存在的条目保留原来的 at（淘汰按最旧）
        ├─ 扫描结果替换缓存（思源是唯一真相，不合并）
        └─ before 里有、found 里没有 → change.removed → _notifyDeletedNotes
```

点击 ↗ 时（`_openSentLink`）再确认一次块还在：

| `_blockExists` | 结果 |
|---|---|
| `true` | 正常打开思源 |
| `false` | `_removeSentMarker` + `_index.remove` + 气泡「原笔记已删除，重新发送？」 |
| `null`（两个通道都不通） | **当作不知道**，照旧打开——不能因为连不上就擦掉标记 |

`_notifyDeletedNotes` 用一个 Set 去重，一次气泡里可以重发多条；重发走
`_send(annotation, reader, ..., { alreadySent: "send" })`，绕过"已经发过"的提问。

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

压缩设置只有一处读取：`content.js` 的 `_pictureSettings()` 返回
`{ compress: imageCompress, quality: imageQuality / 100 }`。框选截图和子笔记里的图片
（`item-pictures.js`）都调它，所以设置页里的「图片」一节对两者同时生效——不是两份恰好
相同的偏好读取。

---

## 7. 模板引擎

- `{{变量}}`、`{{#if 变量}}…{{else}}…{{/if}}`（可嵌套），空值整行裁掉（`dropEmptyLines`）。
- `validateTemplate()` 返回 `unknown / unbalanced / strayClose`：未知变量、少写的 `{{/if}}`、
  多写的 `{{/if}}` 分开报，不会把"多余"说成"未闭合"。
- 变量表 `TEMPLATE_VARIABLES` + 预设 `TEMPLATE_PRESETS` 同时喂给设置页的提示与预览。
- 设置页在光标处插入变量/条件（`template-edit.js`），并把选区包进条件里。

**用户保存的模板**（`template-store.js`，纯函数，不碰 Zotero）：

```
偏好 templates = [{ id, name, template, slot?, destination?, targetDocument?,
                    itemDocName?, itemDocPath? }, …]（JSON 字符串，上限 50）
   saveTemplate( shelf, { id?, name?, template?, slot?, …destination } )
     id 命中          → 更新那一份（给了名字就顺便改名）
     名字命中          → 更新同名的那一份（不会堆出副本）
     都没有            → 新建一份，追加到末尾
   空模板 / 没名字 / 满了 → 返回 error，让面板把原因说给用户听
```

- `parseSavedTemplates()` 对一切手改坏的偏好都返回空列表：非法 JSON、不是数组、
  缺 `template`、缺 `id`（补一个）、`id` 重复（第二个换一个）—— 面板不会因为一个
  偏好打不开。
- 模板可以**带上目的地**（`destination` / `targetDocument` / `itemDocName` / `itemDocPath`）。
  套用一份模板时这几个字段一并写进偏好，所以"发到某篇文献的笔记"可以一键切换；
  没带目的地的旧模板照常工作，只是不改目的地。字段只在是非空字符串时才存，读的时候
  缺失的键自然回落到当前偏好——模板不会用一个空串把用户的全局设置清掉。
- 模板还记得自己属于哪一支编辑框（`slot: "item"`）。套用时先切回那一边，再写进去；
  通用模板不写 `slot`，所以旧模板一律落到通用模板这一边。
- 面板侧：下拉列表 + 名字框 + 保存/套用/删除；**删除按两次**（`_deleteArm`），
  换一份就把待删状态收回去；列表为空时「套用」「删除」置灰。
- 自检（`ui: true`）真的存一份、套回来、删掉，最后把 `templates` 偏好原样写回。

---

## 8. 传输层：两个通道，一个接口

```
SiYuanProcess          找可执行文件、试路径、跑进程、超时、读懂输出
   └─ SiYuanCLI        业务：notebook list / dailynote create / block append / block delete /
                       sql / document create / document search / attr set
SiYuanHTTP             直接打内核 API（读 conf.json 拿 token 和端口，自动发现）
```

写日记的首选路径是**两条命令**，因为只有第二条才回答真正的块 id：

```
siyuan dailynote create --notebook <id>        → 日记文档 id
siyuan block append --parent <文档 id> --file <md>  → { "id": "<块 id>" }
```

旧版 CLI 没有 `block append`，才退回 `dailynote append`（它只回文档 id，块 id 靠 `created`
秒去查）。**注意**：如果命令超时或"可能已经写了"，一律不退回重试，否则会写两遍。

写到指定文档时少一步：文档已经有了，直接 `block append --parent <该文档>`。
「每篇文献一个文档」还要先找到（`sql` 按 `custom-zotero-item-key` 查 `ial`）或建出
（`document create` + `attr set`）那篇文档，这一步在写入之前完成，失败时什么都没写。

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

## 10. 设置页：一个对象，七个脚本

Zotero 把 `scripts` 数组里的文件**按顺序加载进同一个面板作用域**：

| 文件 | 职责 |
|---|---|
| `preferences.js` | 建对象：元素 id、常量、状态、`init()`、共享工具 |
| `preferences-template.js` | 模板编辑器、预设、我的模板 |
| `preferences-variables.js` | 变量列表、筛选、条件变量选择 |
| `preferences-pictures.js` | 图片压缩设置、框选检查 |
| `preferences-sending.js` | 笔记本下拉框、自动发送过滤条件、待发队列 |
| `preferences-actions.js` | 测试连接、重扫索引、自检、预览、模板用途与目标位置 |
| `preferences-boot.js` | **最后**加载，调用 `init()` |

顺序错了面板就是空的，`tools/validate/00-layout.mjs` 会核对这份顺序。

`preferences-sending.js` 的笔记本下拉框在 `onPaneReady` 里异步加载（看板先出现，
列笔记本要 spawn 一次 CLI），「测试连接」成功后再刷新一次。列不出来时保留当前选择，
并标一个「在思源里没找到」的选项——**不因为列不出来就清空设置**。

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
9. **一次发送最多 spawn 一个进程**（`block append`），批量发送**合并成一次 `block append`**
   （外加分组时最多一次 `sql`）。任何"顺手查一下"的 CLI 调用都要先想清楚它是不是每次发送
   都必要——一次 0.6 秒，批量不再乘上去，但单条发送仍然会被它拖慢。
10. **块属性写在同一批 Markdown 里**（`block-attrs.js` → IAL）。不要为每条注释再调一次
    `attr set`：那会多一个进程。IAL 值里不能留双引号/反斜杠（思源不把反斜杠当转义）；
    属性必须挂在超级块的 `}}}` 之后——挂在最后一个子块后面会标到子块头上。
11. **凡是读 `blocks` 行给发送用的查询，都要 SELECT `ial`**。批量分组和「替换上次」
    都靠这一列把块对回笔记；少了它，前者退化成锚点，后者可能把同一秒写入的整批当成一条。
12. **一次发送 = 一个超级块**（`markBlock`）。属性映射只在「写入返回的每一行都能对上号」
    时才接受——对不上就退回锚点路径或干脆不映射，宁可让用户再发一次，也不要把删除
    打到别人的笔记上。
12. **侧栏每次渲染 header 的代码不能做全文档查询**。一个 PDF 几百条注释，一次渲染就是
    几百次查询；手动标记走 `_manualLinksOf` 的 `WeakMap`，不要退回 `querySelectorAll`。
13. **异步调用必须 `await`**。`IOUtils.exists()` / `Zotero.Items.getAsync()` 这类返回的是
    promise，而 promise 恒为真——`if (IOUtils.exists(x))` 什么都检查不到。`npm run check`
    里有一条 `Async calls are awaited` 专门扫这个（注释和字符串会先被剥掉）。
14. **模板变量不能是"永远是空"的**。`{{annotatorDate}}` 曾经如此：Zotero 给阅读器的注释
    JSON 里**没有日期**，而这个变量正是从那里取的。现在它从条目取，且只在模板真的用到时
    才查一次条目（`_templateUses`，按模板字符串缓存）。
15. **索引扫描一次会话只跑一次**（`ensureScanned` + `INDEX_TTL_MS`）。`LIKE '%…%'` 本来
    就要读整张表，按 PDF 分片省不下扫描量，只是把同样的活儿做了 N 遍——实测（1341 行的
    表）整表查询 4–6 ms、单个 PDF 3–5 ms，而两者各要 spawn 一次进程。并发的侧栏必须等
    同一个 Promise（`_scanning`），否则恢复八个标签页就是八次全表查询。
16. **发送期间所有按钮都置灰**（`_setReaderBusy`），而且在发送中途渲染出来的 header 也要
    一出生就是 disabled（`_busyDocs`）。只禁用被点的那一个，等于允许"再点一下"写第二条。
17. **气泡画在调用方给的文档里**（`showToast({ doc })`）。跨窗口投递在阅读器占满窗口时
    等于没显示；每个文档一个 stack（`WeakMap`），不要退回到"全局一个容器"。
18. **索引属于一个 workspace**（`ensureScanned({ key })`）。“这条注释发过”这个映射只存在
    于某个 workspace 里，换 workspace 之后旧索引里的标记全是死链，所以 key 变了就先清空。
19. **"这个 PDF 索引过了"只在一定时间内成立**（`_indexedAttachments` + `INDEX_TTL_MS`）。
    原来记一次就永远跳过，于是思源里新增/删除/同步进来的笔记永远不会反映到侧栏。
20. **索引也能走 HTTP**（`_indexTransport` + `POST /api/query/sql`）。CLI 起不来但内核能
    连上时，发送是好的，可重启后所有标记消失——只因为扫描只会用 CLI。
21. **自动发送默认关闭，且过滤器是"与"关系**。任何一个维度留空 = 不限，别把空列表
    解释成"什么都不发"；也别把 `autoSend` 的默认值改成 `"1"`。
22. **监听器和菜单必须成对拆掉**。Notifier observer、`_autoSendTimers`、`_queueTimer`、
    条目菜单、`sentCache` 的定时写入，都在 `onShutdown` / `onMainWindowUnload` 里收尾；
    `_shutDown` 之后启动的回调要自己返回。
23. **连不上 ≠ 被删除**。`_blockExists` 的三态（true / false / null）不能在调用方压成
    布尔值，否则思源关着时点一次 ↗ 就会把标记全擦掉。

---

## 12. 已知的取舍

- 索引的查询是 `LIKE '%…%'`，数据库大时单次会慢——但它**不是每次侧栏都跑**
  （`INDEX_TTL_MS` 5 分钟，`ensureScanned`），期间所有 PDF 都从这一次结果里回答。
  并发的侧栏会等同一个 Promise，不会各起一次。整表扫描失败时才退回"这个 PDF 单独查"。
  代价是思源里外部改动最多要 5 分钟才出现在侧栏，且换 workspace 或到点之后会重扫一次。
- 手动标记（`data-zsi-manual`）按文档建了 `WeakMap`，每个文档只扫一次 DOM；代价是插件
  被重载后由**旧实例**插入的标记要靠那次扫描找回来——扫描用 `isConnected` 兜底，找不到
  就当它已经被 reader 擦掉了。
- 批量发送**合并成一次写入**：12 条注释是一个 `block append`，不再串行等 12 个进程。
  代价是它们落在同一秒里，重启后"这次写入的块"不能只靠创建时间区分。现在每条笔记
  各自是超级块、属性挂在容器上，分组和「替换上次」按属性精确切分；`zsi=batch` 锚点
  是升级前老笔记的退路。属性丢失且锚点也丢失时，只有第一条能确定归属，其余的不进索引
  （宁可让用户再发一次，也不要把标记打到别人的笔记上）。
- 压缩后的图片在内存里留一份（最多 12 张 / 32 MB），所以"同一张图再发一次"不必重新
  解码 + 重编码。代价是插件退出前占着这些内存（`forgetPictures()` 在 `onShutdown` 里清）。
- 预览气泡显示在**调用方给的文档**里（阅读器发送就弹在阅读器里）；如果那次发送来自
  一个即将关闭的标签页，气泡会跟着那个文档一起消失——这是不要跨窗口投递的代价。

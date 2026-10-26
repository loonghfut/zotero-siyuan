# Zotero → SiYuan

把 Zotero PDF 阅读器侧边栏里的**注释（annotation）和它上面的评论（comment）**，一键写进
**思源笔记当天的日记**。

在 Zotero 阅读器的左侧注释面板中，每条注释标题旁会出现一个 ➡ 按钮。点它之后：

- 注释选中的原文 → 思源的 `> [!quote]` 引用块
- 你自己写的评论 → 思源的 `> [!note]` 备注块
- 作者 / 年份 / 出处 / 页码 / 批注人 → 一行元信息
- 文献标题 → 一个 `zotero://open/library/items/…?annotation=…` 深链，点开直接跳回 Zotero 的**那条注释**

写完之后，注释旁边会多出一个 ↗ 标记，点它直接跳到思源里对应的那一块。

写入效果（思源日记里）：

```markdown
> [!quote] 摘录 · Attention Is All You Need
> The dominant sequence transduction models are based on complex recurrent or convolutional neural networks.

> [!note] 批注
> This is the core idea of the paper.

作者：Ashish Vaswani  
年份：2017  
出处：Advances in Neural Information Processing Systems  
页码：3  
批注人：steve  
来源：[Attention Is All You Need](zotero://open/library/items/ATTACH01?annotation=ANNO0001&page=3)
```

## 自定义发送模板

设置面板里有一个模板编辑框，写的是**普通 Markdown**，用 `{{变量}}` 插入内容：

```markdown
> [!quote] 摘录 · {{title}}
{{imageCallout}}{{quoteCallout}}

{{#if comment}}> [!note] 批注
{{commentCallout}}

{{/if}}{{metadata}}
```

- `{{变量}}` —— 插入一个值
- `{{#if 变量}}…{{/if}}` —— 只在变量不为空时保留这一段（没有评论时就不会留下空的批注块）
  - 条件可以**嵌套**：`{{#if a}}{{#if b}}…{{/if}}{{/if}}`，`{{/if}}` 会和最外层的那个配对
- **没有值的变量不会留下空行**：一行里如果只有变量、而它们都没有值，这一行**整行消失**。
  行里如果有自己的文字，那一行保留 ——「作者：」还在，只是没有名字

  ```markdown
  {{quoteInline}}   ← 没有值，这一行消失
  {{image}}         ← 没有值，这一行也消失
  {{comment}}       ← 有值，从这里开始
  [{{title}}]({{zoteroAnnotationLink}})
  ```

  → 写出来是

  ```markdown
  你的评论
  [论文标题](zotero://open/library/items/…)
  ```

- 面板下方有**实时预览**，用的是你库里真实的一条注释，边写边看效果
- 还有一张**变量速查表**，列出所有可用变量和它们的含义
- **点一下变量名，就把它插到模板的光标处**；模板里已经用过的变量会加粗，变量按用途分组。
  插好后光标停在插进去的内容后面，所以可以连续点好几个变量

### 编辑模板时少走弯路

写模板最费劲的是「不知道从哪开始」和「变量太多找不到」。面板为此做了几件事：

| | |
|---|---|
| **模板预设** | 顶部有下拉框：默认、极简、框选图片单独一行、全文笔记。挑一个，再改细节 |
| **语法校验** | 编辑器上方会直接说「哪个变量不存在」「哪个条件没闭合」—— 不用等发出去才发现 |
| **变量过滤** | 变量表上面有搜索框，按**名字或说明**过滤；还有个「只看已用」开关 |
| **Tab 缩进** | 编辑框里按 Tab 插入两个空格，而不是跳到下一个控件 |
| **整块变量独占一行** | `{{quoteCallout}}` 这类变量自带 `> `，插到行中间会把引用块弄坏 —— 插件会自动换行，并**保留那一行的缩进** |

主要变量：

| 变量 | 含义 |
|---|---|
| `{{quote}}` `{{quoteCallout}}` `{{quoteInline}}` | 摘录原文：原样 / 每行加 `> ` / 转义成一行 |
| `{{comment}}` `{{commentCallout}}` `{{commentInline}}` | 你的批注，同样三种形态 |
| `{{image}}` `{{imageCallout}}` | 框选注释的截图（原样 / 每行加 `> `），普通注释为空 |
| `{{title}}` `{{titleInline}}` | 文献标题 |
| `{{authors}}` `{{author}}` `{{year}}` `{{publication}}` | 作者 / 第一作者 / 年份 / 出处 |
| `{{doi}}` `{{isbn}}` `{{url}}` `{{abstract}}` `{{itemType}}` `{{tags}}` | 其它文献字段 |
| `{{page}}` `{{pageNumber}}` `{{annotator}}` `{{annotationType}}` | 注释所在页 / 批注人 / 注释类型 |
| `{{date}}` `{{time}}` `{{timestamp}}` | 发送当天日期与时刻 |
| `{{zoteroLink}}` | 打开条目的 `zotero://` 链接 |
| `{{zoteroAnnotationLink}}` | **直接跳到这条注释**的 PDF 位置 |
| `{{metadata}}` | 作者/年份/出处/页码/批注人/来源，整块 |

## 框选注释（图片注释）

在 PDF 上**拖拽框选**一段区域，Zotero 记下来的是一条 **image / ink 注释**：它**没有文字**，
选中的内容是一张**截图**。这类注释以前发过去等于「发了个空引用块」，选区本身全丢了。

现在这类注释会把**图片一起送到思源**：

- 图片从 Zotero 的缓存里取（`<Zotero 数据目录>/cache/library/<注释 key>.png`），
  **一个字节不改**地复制到思源工作空间的 `data/assets/` 下
- Markdown 写成思源自己的样子：`![框选](assets/zotero-siyuan-<注释key>-<时间戳>.png)`
- 图片放在 `> [!quote]` 引用块**里面** —— 框选的内容本身就是「摘录」，
  所以**默认模板不用改**就能正确输出
- 思源内核会**自己**把这份资源登记进它的资源表并生成真正的 `<img>`，
  插件不需要再上传一次

> **模板不用改也能有图。** 如果你的模板里没有 `{{image}}` 或 `{{imageCallout}}`，
> 插件会把图片**自动追加**到笔记末尾 —— 选区不该因为模板写得早而丢失。
> 反过来，模板里写了 `{{imageCallout}}` 的话，图片就放在你指定的那一行，
> **而且只出现一次**（`{{quoteCallout}}` 不会重复它）。
>
> 图片找不到时（缓存文件缺失、注释是同步过来的）**不会报错**：笔记照写，只是没有图片 ——
> 一张丢掉的图片不该连你的评论一起丢掉。
> 阅读器手里还带着这张图时，会退回用它的内存副本补上。
>
> 文件名里带时间戳，是为了每次发送都得到**独立的资源**，
> 免得同名文件在思源的资源表里变成重复行。
>
> 图片是在**笔记写入之前**放进工作区的 —— 笔记得指向一个真的存在的文件。
> 所以写失败的时候插件会**把自己那张图删掉**，自检也会把它写进去的图片**收回来**：
> 工作区是用户的，不留垃圾。

### 框选图片看得见吗？

设置面板里有一个「**检查框选图片**」按钮：它把库里所有框选注释列出来，
告诉你 Zotero 的缓存目录在哪、每条注释的图片路径算出来没有、**文件在不在磁盘上**。
图片发不出去的时候，先点这个 —— 断在哪一环，一眼就能看出来。

端到端自检里也有同样的一步：它拿一条**真实的**框选注释跑完整条链路
（找图 → 放进工作空间 → 渲染 → 笔记里有没有图片链接），结果写在自检报告里。

> **每一次图片发送都会留下"链路记录"**：是不是框选注释、key 是什么、
> 缓存路径算出来没有、文件在不在、工作空间是哪个、导出成功没有。
> 出问题的时候，报告里直接写着**卡在哪一环、报的是什么错** ——
> 一个什么都不说的失败，是最难找的那种失败。

## 双向跳转

| 方向 | 怎么实现 |
|---|---|
| 思源 → Zotero | 模板里的 `{{zoteroAnnotationLink}}`，形如 `zotero://open/library/items/<附件key>?annotation=<注释key>&page=<页码>`，精确到那一条注释 |
| Zotero → 思源 | 注释旁出现 ↗（**思源自己的图标**），点开跳到思源对应块 |

### 「这条注释发过了」记在哪？

**记在思源那边，Zotero 库里不留任何痕迹。**

之前用 tag（`siyuan:<块ID>`）记过，但那样会污染标签栏、跟着 Zotero 服务器同步、
共享库里的别人也能看见，而且它本身并不是一个链接。

现在的做法是**让思源做唯一真相**：插件写的每个块，元信息里都带着那条 Zotero 深链，
所以"这条注释发到了哪个块"可以直接从工作空间里读回来：

```sql
SELECT id, markdown, type FROM blocks
WHERE markdown LIKE '%zotero://open/library/items/%'
```

插件启动时扫一遍，把「注释 key → 思源块 ID」建成内存索引；发送新注释时立刻增量更新。
于是：

- 你的 Zotero 库里**一个标记都不会留下**（没有 tag、没有备注、条目干净）
- 换电脑、重装插件都自动恢复 —— 索引是从思源重建的
- 同一条注释发多次，索引指向**最后一次**的块
- 设置面板里有「重新扫描已发送的注释」按钮，随时可以重建

> 索引认的是**块的 Markdown**，不是纯文本内容：思源会把 `[文字](zotero://…)` 改写成
> `<span data-href="zotero://…">`，而纯文本那一列里已经没有链接了。
> 也因此，模板里如果完全不写 `{{zoteroAnnotationLink}}`，历史记录就扫不到
> （刚发的那条仍然可以跳，因为它是增量加入索引的）。

### 标记立刻出现，不用重开论文

发完之后插件会**直接更新已经渲染好的侧边栏**，↗ 立刻出现在那条注释旁边。
打开一篇论文时，如果这篇的块还没进索引，插件会在后台查一次，查完自动补上标记 ——
不用像以前那样把论文关了再打开。

> 阅读器给插件的挂载点有个奇怪的规矩：**每一次 `append()` 调用都会得到一个独立的盒子**，
> 而**每次重绘都会先把盒子清空**。所以按钮和 ↗ 标记必须放进**同一次** `append()` ——
> 分两次调用就会落进两个盒子，谁也看不见谁，标记就会变成两个。
> 因此查重也是**按注释 key 在整份文档里查**，而不是只看按钮的旁边。
>
> 插件手动插进去的标记会打上 `data-zsi-manual`，阅读器自己渲染的那份没有 ——
> 两条路径不会同时出现在同一个注释上。自检里专门有一步复现这个场景：
> 渲染 → 手动插入 → 再渲染 → 再渲染，标记数量必须始终是 **1**。

### 论文是上次会话留下的？按钮也会补上

Zotero 启动时会恢复上次的阅读器标签页，而**阅读器可能在插件还没加载完时就把侧边栏画好了** ——
这时插件听不到任何渲染事件，侧边栏上一个按钮都不会有。

所以插件启动后会自己看一遍所有打开的阅读器，把缺按钮的补上：注释的 key 能从
阅读器给页码标签起的名字（`page_<注释 key>`）里读出来，补完之后按原样画进阅读器的盒子里。
阅读器下次重绘时会用自己的那份把补的换掉 —— 外观完全一致。

> 只有**注释预览**里的盒子才算数：工具栏和划词弹窗也有同名的盒子，
> 认错了就会把按钮插到工具栏里去（曾经真的发生过）。

### 点 ↗ 不会再弹确认框

`Zotero.launchURL("siyuan://…")` 会走浏览器的外部协议服务，**每次都要先问一句**
"要打开外部程序吗"。插件改成**直接启动思源**：从注册表（或默认安装位置）找到
Windows 为 `siyuan://` 注册的程序，直接把它跑起来，URL 作为参数传过去 ——
已在运行的思源窗口会被唤到前台并跳到那个块，全程不打扰。

作为双保险，插件启动时还会设上 `network.protocol-handler.warn-external.siyuan = false`
（就是那个确认框里"记住我的选择"复选框写的东西），所以万一走回退路径也不会再问。

> 插件沙箱里读不到注册表服务（`@mozilla.org/windows/registry-service;1` 是
> `undefined`），所以查注册表用的是 `reg.exe` —— 而且 Gecko 的 `Subprocess`
> 只接受**绝对路径**，光写 `reg.exe` 会被判成"不是可执行文件"。

### 思源图标怎么放进去的

**内联 SVG** —— 这是阅读器里唯一可靠的方案。

阅读器的侧边栏跑在**独立的内容进程**里，而插件用 `registerChrome` 注册的 chrome 包是
**local** 的：只有注册者自己的 principal 能加载它。所以 `chrome://zoteroSiYuan/…` 在设置面板里
能显示，在阅读器里却是**一个空方块**（local 包跨进程不可读）。

内联 SVG 不需要任何 URL，因此在任何文档里都能渲染 —— 而 **Zotero 自己的图标本来就是 SVG**。

图形是思源官方应用图标（`resources/stage/icon-large.png`）**逐像素描出来的**：扫描原图的
alpha 与颜色边界，得出四个多边形，配色取自原图的红 `#DA3939` 与深灰 `#3B3E43`：

```js
export const SIYUAN_ICON_SHAPES = [
  { points: "158,84 165,84 165,316 46,435 46,196", fill: "#DA3939" },
  { points: "166,84 173,84 255,166 255,316 166,405", fill: "#3B3E43" },
  { points: "338,84 345,84 345,316 256,405 256,166", fill: "#DA3939" },
  { points: "346,84 465,203 465,435 346,316", fill: "#3B3E43" },
];
```

还原度做过视觉比对：与官方原图几乎完全一致，14 px 下也能一眼认出。

### 大量注释时的性能

| 做法 | 效果 |
|---|---|
| 索引**按 PDF 分片**查询 | 打开一篇论文只查它自己的块，不扫全工作空间 |
| 侧边栏**事件委托** | 每个 reader 文档一个监听器，而不是每个标记一个 |
| 只在**确实发过**时才建 DOM | 没发过的注释不产生任何额外节点 |
| Fluent 标签**只解析一次** | 几百个注释头不会重复走一遍本地化 |
| 索引刷新**先建后替换** | 查询失败不会把已经知道的映射弄丢 |

## 批量发送

在阅读器里选中多条注释 → 右键 → 「把 N 条注释发送到思源笔记」。
每条都按同一套模板渲染，依次写入，结果用气泡汇总。

## 发送后的反馈

写入成功后右下角会弹一个气泡，写明写进了哪个笔记本，并带一个「在思源中打开」的链接。

## 为什么用 siyuan 命令行

插件**优先走思源自带的 `siyuan` 命令行**（SiYuan 3.7+ 内置），命令行不可用时才退回
思源的 HTTP API：

```
siyuan dailynote append --notebook <笔记本 ID> --file <临时 md> -w <工作空间>
```

这样做的好处：

- **不需要 API Token、主机、端口**，思源的日记路径由思源自己按「设置 → 外观 → 日记」解析，
  插件永远和思源自己的设置一致。
- **不受思源 3.8 的「结构化标题模式」影响。** 思源 3.8 起，老的
  `getIDsByHPath` / `createDocWithMd(path)` 接口在开了结构化模式的笔记本里会直接报
  `legacyPathUnsupported`；而 `siyuan dailynote append` 已经把这层兼容处理好了。
- 日记不存在时由 CLI 负责创建（包括 `daily note/2026/10/2026-10-25` 这样的多层路径）。

> HTTP 兜底有个必须知道的坑：思源内核会**统计失败的鉴权并锁死自己**
> （`认证失败次数过多，请稍后重试`）。所以兜底逻辑优先试你配置里的工作空间、
> 最多只试 3 个 token，绝不横扫你打开过的所有工作空间。

## 项目结构

基于社区官方模板 [windingwind/zotero-plugin-template](https://github.com/windingwind/zotero-plugin-template)
和 [zotero-plugin-scaffold](https://github.com/northword/zotero-plugin-scaffold) 构建 —— 清单文件、
`prefs.js` 和 XPI 压缩包都由 scaffold 生成，和上千个在用的 Zotero 插件完全同构。

```
zotero-siyuan/
├── package.json                 # 插件 ID、命名空间、偏好前缀
├── zotero-plugin.config.ts       # 构建配置（esbuild / FTL / 偏好前缀）
├── tsconfig.json
├── .env                         # `npm start` 用的 Zotero 路径与 profile
├── src/                         # 插件逻辑（esbuild 打包）
│   ├── index.js                 #   入口：注册阅读器事件、偏好面板
│   ├── modules/siyuan.js        #   siyuan CLI 客户端
│   ├── modules/siyuan-http.js   #   思源 HTTP API 兜底
│   ├── modules/siyuan-image.js   #   框选注释的截图：取图、放进思源 assets
│   ├── modules/metadata.js      #   元信息采集 + 深链生成
│   ├── modules/template.js      #   发送模板引擎 + 变量表
│   ├── modules/siyuan-index.js   #   「已发送」索引（只存在思源里）
│   ├── modules/icons.js         #   思源图标（内联 SVG）
│   ├── modules/siyuan-launcher.js #  直接启动思源，不弹协议确认框
│   ├── modules/toast.js         #   通知气泡
│   ├── modules/selftest.js      #   端到端自检
│   ├── modules/diagnostics.js   #   故障诊断报告
│   └── utils/{prefs,locale,paths,http}.js
├── addon/                       # 静态资源，scaffold 会做占位符替换
│   ├── bootstrap.js             #   生命周期钩子
│   ├── manifest.json            #   清单（版本号必须每次构建都动）
│   ├── prefs.js                 #   默认偏好
│   ├── content/                 #   偏好面板、样式、图标
│   └── locale/{en-US,zh-CN}/    #   Fluent 字符串
├── tools/
│   ├── validate.mjs             # 静态回归闸门（npm run check）
│   ├── sync-xpi.mjs             # 把构建产物同步到仓库根目录
│   ├── make-sample.js           # 用插件自己的模板引擎生成样例
│   └── siyuan-cleanup.mjs       # 清理自检留在日记里的块
└── .scaffold/build/             # 构建产物（含 zotero-to-si-yuan.xpi）
```

## 环境要求

| | |
|---|---|
| Zotero | 7.0 及以上（已在本机 Zotero 10.0.6 上核对 API） |
| 思源笔记 | 3.7 及以上（`siyuan` 命令行随内核附带） |
| Node.js | 20 及以上（构建用） |

Windows 上 `siyuan.exe` 通常在：

```
%LOCALAPPDATA%\Programs\SiYuan\resources\kernel\siyuan.exe
```

插件会依次尝试：偏好设置里填的路径 → PATH → 上述默认安装位置 → `%ProgramFiles%` 下的同名路径。
每一项都**先验证能不能启动再使用**，失败会继续往下试。

## 构建

```bash
npm install
npm run build     # 产物：zotero-siyuan.xpi（构建后自动同步到仓库根目录）
npm start         # 启动 Zotero 并热重载插件（开发用）
npm run check     # 静态回归闸门（198 项）
```

`npm start` 需要先在 `.env` 里填好 Zotero 路径；它会建一个独立的 `dev` profile，
不会碰你的主库。

`npm run check` 跑的是 `tools/validate.mjs`，用来挡住**「构建成功但运行不起来」**那一类问题：

- 所有 JS 语法检查；
- **回调是否正确 bind** —— Zotero 派发阅读器事件时用自己的 `this` 调你的 handler，
  不 bind 就会出现 `this._send is not a function`；
- 代码里用到的每个 Fluent id 在两种语言里都有定义；
- **Fluent 文件能被真正的 Fluent 解析器解析**：Fluent 把 `{` 当作占位符的起始，
  所以文本里写了 `{{变量}}` 的那一条会变成 junk，根本到不了界面上 —— 只有解析器看得出来；
- `siyuan` 命令行的候选路径推导（含「只知道 home 目录」这种最差情况）；
- 思源工作空间能被鉴权发现（内核在限流时这一项会被跳过并说明原因）；
- **默认模板能被真的渲染一遍**：callout 在、没有未知变量、回链指向那条注释、
  没有评论时不留空块；
- **模板的条件嵌套不留残渣**：外层条件为空时不会漏出字面量 `{{/if}}`；
- **索引的扫描不会弄丢刚发的注释**：扫描期间发出去的块必须活过那次扫描；
- **自检不接管插件**：它不能替换插件自己的方法，否则你同时点的按钮会被它吞掉；
- **语言包不被钉死在英文**：语言选择跟着 Zotero 的界面语言走；
- 标题里的方括号会被转义，不会把「来源」那行的链接拆坏；
- **框选注释的图片真的能落地**：图片会被复制进工作空间的 `data/assets`、
  Markdown 指向它、没有文字的框选注释照样有摘录块、批量发送时也带着图；
- **模板没写图片变量时，图片也会进笔记**（自动追加），写了就只出现**一次**；
- **没有值的变量不占位置**：一行里只有变量而它们都没有值时，整行消失；
  空的引用块也不是一个孤零零的 `>`；
- **只用真实存在的文件 API**：`IOUtils.newFile` 根本不是 Gecko 的 API
  （`IOUtils.write` 直接收路径），`PathUtils.join` 也不接受**带分隔符**的组件 ——
  这两个都真的发生过，所以闸门里的替身**不**比真的更宽容；
- **模板编辑**：整块变量会自动独占一行并保留缩进、未知变量和没闭合的条件会被找出来；
- **没人引用的图片会被收走**：写失败的发送会把自己那张图删掉，
  自检也会把它写进去的图片收回来 —— 工作区是用户的，不留垃圾；
  自检还会**前后对比**工作区的图片目录：写了一半失败而没被 Markdown 提到的图也会收走，
  而**任何笔记引用着的图都会留下**（哪怕是你在自检运行时自己发的那条）。
- 打好的 XPI 里该有的文件都在、manifest 字段齐全、**manifest 的版本号与 `package.json` 一致**、
  `prefs.js` 只含双引号格式的 `pref(...)` 行。

> **为什么版本号必须每次都动**：Firefox 把已安装插件的清单缓存在 profile 的
> `extensions.json` 里，**同版本号替换 `.xpi` 可能不生效**，旧代码会继续跑。
> 所以每次改代码都要动 `addon/manifest.json` 的版本号 —— `npm run build` 会自动
> bump，`npm run check` 会盯着 manifest 与 `package.json` 是否一致。

> **装插件的正确顺序**：**先关掉 Zotero，再覆盖 `.xpi`**。Firefox 用内存映射
> （memory-mapped section）打开着 XPI，Zotero 运行时覆盖它会直接失败
> （`请求的操作无法在使用用户映射区域打开的文件上执行`）。覆盖失败如果被忽略，
> Zotero 重启后就会加载旧代码 —— 而且日志里看不出来。装完记得比一下哈希。
>
> ```powershell
> # 关 Zotero → 确认进程没了 → 覆盖 → 校验哈希 → 再启动
> [System.IO.File]::Copy(".\zotero-siyuan.xpi", "$profile\extensions\zotero-siyuan@example.com.xpi", $true)
> (Get-FileHash "$profile\extensions\zotero-siyuan@example.com.xpi").Hash -eq (Get-FileHash ".\zotero-siyuan.xpi").Hash
> ```

## 端到端自检

插件**自己就是自己的测试台**：启动时会在后台跑一次端到端自检，把结果写成 JSON 报告：

```
%LOCALAPPDATA%\Temp\Zotero\zotero-siyuan-selftest.json
```

自检走的是**和你点按钮完全一样的代码路径**，一个环节都不 mock：

```
renderSidebarAnnotationHeader 事件 → 真的按钮 → 真的 click()
  → _send() → 渲染模板 → 解析笔记本 → 写思源 → 定位块 ID → 写进索引
```

默认是 **dry run**：最后一步换成 `siyuan dailynote append --dry-run`，让思源自己校验
这条命令，但**不写任何东西**。

把偏好 `extensions.zotero.zoteroSiYuan.selfTestWrite` 设成 `1`，自检就会**真写一次**：
它会挑你库里一条真实的注释，发送、核对块 ID 记进了索引，然后**把自己留下的痕迹
全部清掉**（删思源里的块）。

> 自检**只删自己写的那几个块**。它挑的是「这一次发送写出来的块」，
> 而不是「这条注释在索引里指向的块」——后者可能是你自己早先发出去的那一条。
> 清理之后，索引会指回你原来那个块。

自检里还有两步是拿**真的阅读器**跑的：一步检查每个打开的阅读器都显示出了按钮
（包括插件启动前就画好侧边栏的那种），一步在真的侧边栏里点一次按钮，确认
**每条注释恰好一个 ↗**。这两步跑不动的时候（比如阅读器还没加载 PDF）会跳过并写明原因，
不会误报失败。

设置面板里也有一个「运行端到端自检」按钮，可以随时手动跑一次。

失败时还会额外写一份 `zotero-siyuan-diagnostics.json`，里面有每个候选路径为什么不行、
`Services.dirsvc` / `PathUtils` / `Services.env` 在插件作用域里到底能不能用等原始信息。

清理自检留下的块：

```bash
node tools/siyuan-cleanup.mjs --workspace "D:\siyi" --list
node tools/siyuan-cleanup.mjs --workspace "D:\siyi" --marker ZoteroSiYuanSelfTest
```

## 安装

### 方式一：安装 XPI

「工具 → 附加组件 → 齿轮 → 从文件安装附加组件」，选 `zotero-siyuan.xpi`。

### 方式二：从源码加载（开发用）

1. 启动一次 Zotero，用独立 profile：`zotero.exe -p dev`
2. 关闭 Zotero。
3. 在 profile 的 `extensions` 目录里建一个**以插件 ID 命名**的文件
   （`zotero-siyuan@example.com`），内容是插件源码目录的**绝对路径**，不含任何其它字符。
4. 编辑同目录下的 `prefs.js`，删掉含 `extensions.lastAppBuildId` 和
   `extensions.lastAppVersion` 的两行，保存。
5. 启动 Zotero，插件就会出现在「工具 → 附加组件」里。

> `prefs.js` 的格式有坑：它会被解析两次 —— Zotero 启动时用 JS 加载（单双引号都行），但
> Firefox 安装 XPI 时用一个只认 `pref("name", value);`（**双引号**）的严格解析器。
> 本项目用 scaffold 生成 `prefs.js`，格式天然正确。

## 设置

插件设置面板（Zotero 设置里插件名下面那一项）：

| 偏好 | 默认 | 说明 |
|---|---|---|
| `cliPath` | 空 | `siyuan` 命令行路径。留空则自动查找 |
| `workspace` | 空 | 思源工作空间目录。留空 = 用 `siyuan` 当前的工作空间 |
| `notebook` | 空 | 写进哪个笔记本（名称或 ID）。留空 = 第一个笔记本 |
| `template` | 空 | 发送模板。留空 = 内置默认模板 |
| `selfTest` | `1` | 启动时跑一次端到端自检（dry run） |
| `selfTestWrite` | 空 | 设成 `1` 时自检会真的写一条（写完自己清理） |

面板里的「测试连接」会跑一次 `siyuan workspace info` + `siyuan notebook list`，
把找到的笔记本列出来，并显示**实际使用的**可执行文件路径和工作空间。

> **路径分隔符的坑**：Firefox 启动外部程序前会检查
> `PathUtils.isAbsolute(path)`，而 Gecko 在 Windows 上不认正斜杠路径 ——
> `C:/Users/.../siyuan.exe` 会被判为「不是可执行文件」，`C:\Users\...\siyuan.exe` 才认。
> 插件会把正斜杠换成反斜杠，并且**先验证再使用**；你填的路径不可用时会
> 自动回退到自动查找，并在日志里说明。留空即可全自动。

查你自己的工作空间和笔记本：

```powershell
siyuan workspace list
siyuan workspace info
siyuan notebook list -w "D:\siyi"
```

## 已知限制

- 阅读器界面用**自己的 Fluent bundle**，不读插件的 `.ftl`，所以按钮的提示文字由插件在插件
  作用域里解析后以普通属性写入。插件按 Zotero 的界面语言挑选语言包（`zh-CN` → `en-US`），
  某个词条在译文里缺失时退回英文，不会整条消失。
- 注释面板的按钮由 `Zotero.Reader` 的 `renderSidebarAnnotationHeader` 事件注入。
  这是 Zotero 官方的阅读器扩展点，但 Zotero 每次升级都可能调整阅读器内部结构。
- 插件每次启动都会跑一次自检（dry run，约 2 秒，后台进行）。不想要可以设
  `extensions.zotero.zoteroSiYuan.selfTest` 为 `0`。
- 自检在跑的时候**不会碰你的发送**：它只是在按钮被点中的那一瞬间挂上观察钩子，
  钩子只作用于它自己点的那一次。你在这期间自己点的按钮，写的还是你自己的日记。

## 已验证的部分

| 环节 | 状态 |
|---|---|
| 按钮出现在阅读器侧边注释面板 | ✅ 你在 16:41 截图里点到了它 |
| 点击事件到达 handler | ✅ 你在 16:41 截图里点到了它 |
| `this._send` 可用（handler 已 bind） | ✅ 自检里按钮的 click 走到了 `_send` |
| `siyuan` 命令行定位与启动 | ✅ 插件在 Zotero 内解析出 `…\AppData\Local\Programs\SiYuan\…\siyuan.exe` |
| 模板渲染 | ✅ 用了你库里的真实条目（LSENBHMQ），含作者/年份/出处/页码/精确深链 |
| 笔记本解析 | ✅ `我的笔记本 (20261016230030-nvb0bgg)` |
| `siyuan dailynote append --notebook --file -w` 真实写入 | ✅ **在真实 Zotero 里点自己那个按钮写入成功** |
| 写入结果回读 | ✅ 思源日记「2026-10-25」里出现 1 个 quote callout + 1 个 note callout + 1 个元信息段落 |
| 新块 ID 定位 | ✅ `siyuan sql` 查到 `20261025202330-bbw9ucw` |
| 「已发送」索引 | ✅ 启动时扫到 4 个块、索引 3 条注释（同一条发两次自动去重）；刚发的即时入索引 |
| 已发送标记渲染 | ✅ 注释旁出现 ↗（思源图标），指向 `siyuan://blocks/<块ID>` |
| 发送后立刻出现标记 | ✅ 不重开论文，标记直接补到已渲染的侧边栏上 |
| 标记不会重复 | ✅ 渲染 → 手动插入 → 再渲染，标记数始终为 1 |
| 思源图标能显示 | ✅ 内联 SVG，4 个多边形；与官方原图做过视觉比对，几乎完全一致 |
| 标记点击跳转 | ✅ 事件委托，点击后拿到正确的块 ID |
| 跳转不弹确认框 | ✅ 直接启动思源（注册表 → `reg.exe` → 默认安装位置三级查找），实测退出码 0 |
| 批量发送入口 | ✅ 阅读器注释右键菜单出现「把 N 条注释发送到思源笔记」 |
| 发送后气泡 | ✅ 气泡出现在内容区，带「在思源中打开」 |
| 设置面板一键插入变量 | ✅ 真的打开 Zotero 的设置窗口，点变量名，模板里就多出 `{{变量}}`，光标停在它后面 |

最后这些是插件自己跑出来的：把 `selfTestWrite` 设成 `1`，重启 Zotero，然后
`%LOCALAPPDATA%\Temp\Zotero\zotero-siyuan-selftest.json` 里会写着 `ok: true`，
`transport` 是 `the siyuan CLI`，`markdown` 是真正写进去的那段内容。

> 深度自检（`selfTestWrite = 1`）会**真的弹出一次 Zotero 的设置窗口**，
> 因为那是唯一能验证「点变量名真的能插入」的办法。默认的 dry run 不会弹窗。

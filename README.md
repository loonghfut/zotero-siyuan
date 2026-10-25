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
{{quoteCallout}}

{{#if comment}}> [!note] 批注
{{commentCallout}}

{{/if}}{{metadata}}
```

- `{{变量}}` —— 插入一个值
- `{{#if 变量}}…{{/if}}` —— 只在变量不为空时保留这一段（没有评论时就不会留下空的批注块）
- 面板下方有**实时预览**，用的是你库里真实的一条注释，边写边看效果
- 还有一张**变量速查表**，列出所有可用变量和它们的含义
- **点一下变量名，就把它插到模板的光标处**；模板里已经用过的变量会加粗，变量按用途分组。
  插好后光标停在插进去的内容后面，所以可以连续点好几个变量

主要变量：

| 变量 | 含义 |
|---|---|
| `{{quote}}` `{{quoteCallout}}` `{{quoteInline}}` | 摘录原文：原样 / 每行加 `> ` / 转义成一行 |
| `{{comment}}` `{{commentCallout}}` `{{commentInline}}` | 你的批注，同样三种形态 |
| `{{title}}` `{{titleInline}}` | 文献标题 |
| `{{authors}}` `{{author}}` `{{year}}` `{{publication}}` | 作者 / 第一作者 / 年份 / 出处 |
| `{{doi}}` `{{isbn}}` `{{url}}` `{{abstract}}` `{{itemType}}` `{{tags}}` | 其它文献字段 |
| `{{page}}` `{{pageNumber}}` `{{annotator}}` `{{annotationType}}` | 注释所在页 / 批注人 / 注释类型 |
| `{{date}}` `{{time}}` `{{timestamp}}` | 发送当天日期与时刻 |
| `{{zoteroLink}}` | 打开条目的 `zotero://` 链接 |
| `{{zoteroAnnotationLink}}` | **直接跳到这条注释**的 PDF 位置 |
| `{{metadata}}` | 作者/年份/出处/页码/批注人/来源，整块 |

## 双向跳转

| 方向 | 怎么实现 |
|---|---|
| 思源 → Zotero | 模板里的 `{{zoteroAnnotationLink}}`，形如 `zotero://open/library/items/<附件key>?annotation=<注释key>&page=<页码>`，精确到那一条注释 |
| Zotero → 思源 | 发送成功后，插件把思源块 ID 记在这条注释的 **tag** 上（`siyuan:<块ID>`），注释旁出现 ↗ 标记，点开跳到思源对应块 |

> 标记存在**注释的 tag** 里，所以它跟着 Zotero 库同步 —— 换电脑、重装插件都还在，
> 而且你可以用这个 tag 搜出所有发过的注释。

思源侧的块 ID 是这样拿到的：`siyuan dailynote append` 返回的是**日记文档的 ID**，
不是新建块的 ID，所以插件会再用 `siyuan sql` 查一次工作空间自己的数据库，把这次写入的
块找出来。

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
│   ├── modules/metadata.js      #   元信息采集 + 深链生成
│   ├── modules/template.js      #   发送模板引擎 + 变量表
│   ├── modules/sent.js          #   「已发送」标记（siyuan: tag）
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
npm run check     # 静态回归闸门（68 项）
```

`npm start` 需要先在 `.env` 里填好 Zotero 路径；它会建一个独立的 `dev` profile，
不会碰你的主库。

`npm run check` 跑的是 `tools/validate.mjs`，用来挡住**「构建成功但运行不起来」**那一类问题：

- 所有 JS 语法检查；
- **回调是否正确 bind** —— Zotero 派发阅读器事件时用自己的 `this` 调你的 handler，
  不 bind 就会出现 `this._send is not a function`；
- 代码里用到的每个 Fluent id 在两种语言里都有定义；
- `siyuan` 命令行的候选路径推导（含「只知道 home 目录」这种最差情况）；
- 思源工作空间能被鉴权发现（内核在限流时这一项会被跳过并说明原因）；
- **默认模板能被真的渲染一遍**：callout 在、没有未知变量、回链指向那条注释、
  没有评论时不留空块；
- 打好的 XPI 里该有的文件都在、manifest 字段齐全、**manifest 的版本号与 `package.json` 一致**、
  `prefs.js` 只含双引号格式的 `pref(...)` 行。

> **为什么版本号必须每次都动**：Firefox 把已安装插件的清单缓存在 profile 的
> `extensions.json` 里，**同版本号替换 `.xpi` 可能不生效**，旧代码会继续跑。
> 所以每次改代码都要动 `addon/manifest.json` 的版本号 —— `npm run check` 会盯着这件事。

## 端到端自检

插件**自己就是自己的测试台**：启动时会在后台跑一次端到端自检，把结果写成 JSON 报告：

```
%LOCALAPPDATA%\Temp\Zotero\zotero-siyuan-selftest.json
```

自检走的是**和你点按钮完全一样的代码路径**，一个环节都不 mock：

```
renderSidebarAnnotationHeader 事件 → 真的按钮 → 真的 click()
  → _send() → 渲染模板 → 解析笔记本 → 写思源 → 定位块 ID → 打 tag
```

默认是 **dry run**：最后一步换成 `siyuan dailynote append --dry-run`，让思源自己校验
这条命令，但**不写任何东西**。

把偏好 `extensions.zotero.zoteroSiYuan.selfTestWrite` 设成 `1`，自检就会**真写一次**：
它会挑你库里一条真实的注释，发送、核对 tag 落到了正确的注释上，然后**把自己留下的痕迹
全部清掉**（删思源里的块、删注释上的 tag）。

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
  作用域里解析后以普通属性写入；解析失败时退回英文。
- 注释面板的按钮由 `Zotero.Reader` 的 `renderSidebarAnnotationHeader` 事件注入。
  这是 Zotero 官方的阅读器扩展点，但 Zotero 每次升级都可能调整阅读器内部结构。
- 插件每次启动都会跑一次自检（dry run，约 2 秒，后台进行）。不想要可以设
  `extensions.zotero.zoteroSiYuan.selfTest` 为 `0`。

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
| 新块 ID 定位 | ✅ `siyuan sql` 查到 `20261025192407-oqv2udw` |
| 「已发送」tag 写入 | ✅ 注释上出现 `siyuan:<块ID>`，自检核对无误后自动清除 |
| 已发送标记渲染 | ✅ 注释旁出现 ↗，指向 `siyuan://blocks/<块ID>` |
| 批量发送入口 | ✅ 阅读器注释右键菜单出现「把 N 条注释发送到思源笔记」 |
| 发送后气泡 | ✅ 气泡出现在内容区，带「在思源中打开」 |
| 设置面板一键插入变量 | ✅ 真的打开 Zotero 的设置窗口，点变量名，模板里就多出 `{{变量}}`，光标停在它后面 |

最后这些是插件自己跑出来的：把 `selfTestWrite` 设成 `1`，重启 Zotero，然后
`%LOCALAPPDATA%\Temp\Zotero\zotero-siyuan-selftest.json` 里会写着 `ok: true`，
`transport` 是 `the siyuan CLI`，`markdown` 是真正写进去的那段内容。

> 深度自检（`selfTestWrite = 1`）会**真的弹出一次 Zotero 的设置窗口**，
> 因为那是唯一能验证「点变量名真的能插入」的办法。默认的 dry run 不会弹窗。

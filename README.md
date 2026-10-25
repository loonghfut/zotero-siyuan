# Zotero → SiYuan

把 Zotero PDF 阅读器侧边栏里的**注释（annotation）和它上面的评论（comment）**，一键写进
**思源笔记当天的日记**。

在 Zotero 阅读器的左侧注释面板中，每条注释标题旁会出现一个 ➡ 按钮。点它之后：

- 注释选中的原文 → 思源的 `> [!quote]` 引用块
- 你自己写的评论 → 思源的 `> [!note]` 备注块
- 作者 / 年份 / 出处 / 页码 / 批注人 → 一行元信息
- 文献标题 → 一个 `zotero://select/library/items/…` 深链，点开直接跳回 Zotero 条目

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
来源：[Attention Is All You Need](zotero://select/library/items/ABCD1234)
```

## 为什么用 siyuan 命令行

插件**不直接调思源的 HTTP API**，而是通过思源自带的 `siyuan` 命令行（SiYuan 3.7+ 内置）来写入：

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

## 环境要求

| | |
|---|---|
| Zotero | 7.0 及以上（已在本机 Zotero 10.0.6 上核对 API） |
| 思源笔记 | 3.7 及以上（`siyuan` 命令行随内核附带） |

Windows 上 `siyuan.exe` 通常在：

```
%LOCALAPPDATA%\Programs\SiYuan\resources\kernel\siyuan.exe
```

插件会依次尝试：偏好设置里填的路径 → PATH → 上述默认安装位置。

## 安装

### 方式一：从源码加载（开发用）

1. 先启动一次 Zotero，用独立 profile：
   ```powershell
   & "C:\Program Files\Zotero\zotero.exe" -p dev
   ```
2. 关闭 Zotero。
3. 在 profile 的 `extensions` 目录里建一个**以插件 ID 命名**的文件，
   内容是插件源码目录的**绝对路径**（不含任何其它字符）：
   ```
   %APPDATA%\Zotero\Zotero\Profiles\<profile-id>\extensions\zotero-siyuan@example.com
   ```
4. 编辑同目录下的 `prefs.js`，删掉含 `extensions.lastAppBuildId` 和
   `extensions.lastAppVersion` 的两行，保存。
5. 启动 Zotero，插件就会出现在「工具 → 附加组件」里。

> 改完代码后用 `-purgecaches` 重启 Zotero：
> ```powershell
> & "C:\Program Files\Zotero\zotero.exe" -p dev -purgecaches -ZoteroDebugText -jsconsole
> ```

### 方式二：安装 XPI

```powershell
node tools\build-xpi.js          # 生成 zotero-siyuan.xpi
```

然后在 Zotero 里「工具 → 附加组件 → 齿轮 → 从文件安装附加组件」，选 `zotero-siyuan.xpi`。

## 设置

「设置 → 高级 → 通用 → 配置编辑器」搜索 `zotero-siyuan`，或者直接用插件自己的偏好面板
（插件名字下面那一项）。

| 偏好 | 默认 | 说明 |
|---|---|---|
| `extensions.zotero-siyuan.cliPath` | 空 | `siyuan` 命令行路径。留空则自动查找 |
| `extensions.zotero-siyuan.workspace` | 空 | 思源工作空间目录。留空 = 用 `siyuan` 当前的工作空间 |
| `extensions.zotero-siyuan.notebook` | 空 | 写进哪个笔记本（名称或 ID）。留空 = 第一个笔记本 |

偏好面板里的「测试连接」会跑一次 `siyuan workspace info` + `siyuan notebook list`，
把找到的笔记本列出来。

查你自己的工作空间和笔记本：

```powershell
siyuan workspace list
siyuan workspace info
siyuan notebook list -w "D:\siyi"
```

## 开发

```bash
node tools\validate.js      # 69 项检查：语法、manifest、Fluent 覆盖、Markdown 格式、CLI 调用序列
node tools\make-icons.js .  # 重新生成图标
node tools\build-xpi.js     # 打包 XPI
```

`tools/validate.js` 用 Node 内置 `vm` 把插件代码跑在一个打了桩的沙箱里，不需要
Zotero 或思源真的在运行。

## 已知限制

- 插件**没有在真实 Zotero 客户端里跑过**：写路径（点按钮 → 思源日记里出现内容）需要在你的
  Zotero 里实测一次。思源那一侧的每一条 CLI 调用都已用 `--dry-run` 在你的本机思源
  3.8.9 上核对过。
- 阅读器界面用**自己的 Fluent bundle**，不读插件的 `.ftl`，所以按钮的提示文字由插件在插件
  作用域里解析后以普通属性写入；解析失败时退回英文。
- 注释面板的按钮由 `Zotero.Reader` 的 `renderSidebarAnnotationHeader` 事件注入。
  这是 Zotero 官方的阅读器扩展点，但 Zotero 每次升级都可能调整阅读器内部结构。

## 目录结构

```
zotero-siyuan/
├── manifest.json              # 插件清单（id: zotero-siyuan@example.com）
├── bootstrap.js               # 生命周期钩子
├── prefs.js                   # 默认偏好
├── content/
│   ├── main.js                # 插件主体：按钮注入、写入流程
│   ├── siyuan.js              # siyuan CLI 客户端
│   ├── format.js              # Markdown 生成
│   ├── preferences.xhtml      # 偏好面板
│   ├── preferences.js
│   └── styles.css
├── locale/
│   ├── en-US/zotero-siyuan.ftl
│   └── zh-CN/zotero-siyuan.ftl
├── icons/48.png, 96.png
└── tools/                     # 开发脚本，不打进 XPI
```

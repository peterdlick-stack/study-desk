# 运行与停止

## 离线演示

安装 Node.js 22 或更新版本后，在仓库中运行 `npm start`。不需要运行 `npm install`，也不需要模型账号。

打开 `http://127.0.0.1:4183/?subject=english`。按 `Ctrl+C` 停止服务，没有后台自启动。演示数据和之后的操作位于 `.local/study-library/`，不纳入 Git。再次启动会继续使用已有记录。

界面的“预置示例”是固定的演示记录，可用于体验确认、保存和恢复。新诊断及批改默认返回未启用提示，不会悄悄消耗模型额度。

## 可选的真实 AI 调用

真实调用需要自行安装并登录兼容的 Codex CLI。项目通过结构化输出调用它；本次公开验收没有运行在线模型，不保证任意 CLI 版本均兼容。

先读 `lib/practice-grader.mjs` 中的调用参数。准备有权使用的本地资料；英语检索根目录可通过 `FREE_READING_TRANSCRIPTS` 指定，目录结构参见 `examples/methods/`。

仅对当前终端进程设置变量，例如 PowerShell：

```powershell
$env:STUDY_DESK_ENABLE_AI = '1'
$env:FREE_READING_TRANSCRIPTS = 'C:\path\to\your\method-fragments'
npm run start:local
```

点击诊断/批改时，当前题目、作答和选取的资料会发送到配置的模型服务；它可能消耗账号额度。普通阅读与保存不会调用模型。`npm start` 始终强制关闭在线模型；要启用需使用 `start:local`。

`STUDY_DESK_CODEX` 可指定 CLI 路径。不要把凭据放进本仓库或任何演示文件。

## 数据目录

| 变量 | 默认值 | 用途 |
|---|---|---|
| `STUDY_DESK_PORT` | `4183` | 本机监听端口 |
| `STUDY_DESK_DATA` | `.local/study-library` | 课程、资料与过程记录 |
| `STUDY_DESK_VAULT` | `.local/vault` | 可选笔记归档目录 |
| `FREE_READING_TRANSCRIPTS` | `examples/methods` | 英语检索片段 |

完整的课程视频、个人讲义与 Obsidian 账本不在公开版本中。归档到自有笔记库前需要配置相应目录与数据结构，默认空目录不代表已完成集成。

不要让两个服务实例同时写同一个数据目录。停止服务后可以复制 `.local/` 备份；重置时先保留备份，再自行处理演示目录。

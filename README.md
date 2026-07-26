# Codex Session Sync

在同一台 Mac 上，Codex 官方账号登录端（`openai` provider）与 API/自定义端
（`custom` 或 `proxy` provider）各自维护本地任务记录。两边默认不会自动共享
会话、名称、归档状态和可继续使用的模型配置。

本项目提供一个本地、可审计、先备份后写入的同步工具，主要解决：

- 新建任务只出现在一端，重启 Codex 后像是“消失”；
- 一端改名后另一端名称没有更新；
- 已归档任务在同步后重新出现在侧栏；
- 历史任务仍绑定退役模型，打开后无法继续回复；
- 不完整回合、空最终回复或 Goal continuation 被误当成正常会话传播；
- 重复运行不断产生完整备份，占用大量磁盘；
- SQLite、JSONL 或同步状态发生中断时缺少可恢复边界。

> 这不是 OpenAI 官方项目。它依赖 Codex Desktop 当前的本地 SQLite/JSONL
> 结构；Codex 升级后应先运行测试再操作真实数据。

## 安全模型

同步器以“完整回合”为最小单位，只复制用户可见且可跨 provider 使用的内容：

- 允许：用户消息、最终助手消息、`task_started`、完整可冷恢复的 `turn_context`、健康的
  `task_complete`，以及带用户起点的明确 `turn_aborted`；
- 排除：reasoning、工具调用、工具输出、压缩上下文、加密状态和 provider
  专属字段；
- 隔离：无最终回复、无用户起点的自动 continuation、进行中或停滞回合；
- 失败：任何带 `task_complete.error` 的回合，即使之前出现过部分 final 文本，
  也一律留在原端并标记异常；
- 冲突：两端同时产生独有内容或同时改成不同标题时，隔离该任务并继续同步
  其他任务，不擅自覆盖；
- 归档：通过持久 tombstone 双向传播，历史缺失 counterpart 不会被重建；
- 写入：普通新历史只做 append，不替换整个 rollout；必须重写时要求无活动回合
  且没有其他进程持有文件；
- 备份：默认只保留最近 1 次；仅在会话文件即将被修改时按需备份，失败运行也执行保留策略。

缺失的模型回答无法可靠重建。本工具会将它标记为
`missing_final_answer`，但不会把 commentary 冒充 final，也不会自动恢复 Goal、
重跑 subagent 或伪造助手内容。

## 环境要求

- macOS 与 Codex Desktop
- Node.js 18 或更高版本
- Python 3
- `sqlite3`、`cmp`、`lsof`

## 使用

```bash
python3 codex_same.py
```

也可以把入口软链接到个人命令目录：

```bash
mkdir -p "$HOME/local/bin"
ln -s "$(pwd)/codex_same.py" "$HOME/local/bin/codex_same.py"
```

首次面对已有 Codex 数据但没有同步状态时，工具会拒绝猜测。确认已经备份后才可
显式初始化：

```bash
CODEX_SYNC_ALLOW_BOOTSTRAP=1 python3 codex_same.py
```

首次 baseline 不会盲目复制所有旧历史；后续新任务、导入的安全活动任务和已管理
配对按同步状态处理。

## 配置

| 环境变量 | 用途 | 默认值 |
|---|---|---|
| `CODEX_SYNC_STATE_DB` | Codex 任务状态库 | `~/.codex/state_5.sqlite` |
| `CODEX_SYNC_CATALOG_DB` | Codex 侧栏目录库 | `~/.codex/sqlite/codex-dev.db` |
| `CODEX_SYNC_SESSIONS_ROOT` | rollout 根目录 | `~/.codex/sessions` |
| `CODEX_SYNC_WORK_DIR` | 工具运行状态与备份 | macOS Application Support |
| `CODEX_SYNC_API_PROVIDER` | 指定 API 端 | 自动选择 `custom`/`proxy` |
| `CODEX_SYNC_BACKUP_KEEP` | 自动备份保留数量 | `1` |
| `CODEX_SYNC_LOG_MAX_BYTES` | 单个同步日志文件最大字节数 | `524288` |
| `CODEX_SYNC_LOG_BACKUP_COUNT` | 同步日志轮转副本数 | `1` |
| `CODEX_SYNC_ALLOWED_MODELS` | 额外允许的模型，逗号分隔 | 空 |
| `CODEX_SYNC_REPAIR_TOOL_SEARCH_THREAD_IDS` | 一次性删除已拒绝轮次协议记录；指定 API 线程 ID，或显式设为 `auto` 扫描全部活动 API 线程 | 空（只报告，不删除） |

运行状态默认位于：

```text
~/Library/Application Support/codex-session-sync
```

这里的状态、日志、健康报告和备份都可能包含任务标题、线程 ID、本机路径或完整
对话，不应上传 GitHub 或发送给他人。

## 测试

不读取真实 Codex 数据的基础测试：

```bash
npm test
```

使用本机真实 schema 的隔离闭环测试（复制到临时目录，结束后自动删除）：

```bash
npm run test:integration
```

集成测试覆盖双向完整回合同步、历史结构迁移、侧栏可见性、新 counterpart 的
未完成首轮，以及生命周期异常隔离。

## 已知边界

- 这是手动单机同步，不是实时、云端或跨设备同步；
- 只支持 `openai` 与 `custom`/`proxy` 的本地配对；
- 双端真实内容冲突需要人工决定，工具不会猜测删除哪一侧；
- active/paused Goal、无最终回复、interrupted continuation 和 subagent
  system error 只能检测与隔离，不能安全自动重跑；
- 附件、工作目录和其他本机路径不保证在不同环境可用；
- 普通完整回合追加可在 Codex 空闲时运行；涉及历史结构、错误尾部或模型元数据
  的整文件重写时，必须先退出 Codex，工具会在 app-server 仍运行时拒绝操作。
- AnyRouter 目前会拒绝 Codex 的动态 `tool_search` 续传记录。运行
  `python3 install_anyrouter_compat.py install` 可安装仅监听回环地址的常驻兼容
  代理，并将 custom provider 指向 `http://127.0.0.1:17831/v1`。代理优先保留
  官方 `additional_tools` 语义，必要时才把已发现工具提升为普通工具。
  `codex_same.py` 每次同步前都会幂等检查该配置与运行版本；健康且版本一致时不会
  重启代理，也不会新增配置备份。
  安装器还会注册一个事件驱动的配置守卫：登录时和 `config.toml` 被改写时检查
  custom 地址，只有发现它漂移回 AnyRouter 直连时才恢复本地代理。守卫不轮询、
  不触碰会话文件，也不会反复生成配置或会话备份。
  安装器会使用独立的命令式认证帮助器读取权限为 `0600` 的 AnyRouter
  凭据，不会把官网登录令牌交给第三方；同时关闭请求压缩，代理还会拒绝
  JWT 形态身份令牌和未解压请求。每次上游请求都会重新读取当前 macOS
  系统代理，切换 Wi-Fi、热点或 VPN 后不需要手动重启兼容代理。
- 同步器默认不会删除 `tool_search_call`/`tool_search_output`。如需对旧的失败
  尾部执行一次性修复，必须显式设置
  `CODEX_SYNC_REPAIR_TOOL_SEARCH_THREAD_IDS=auto` 或指定逗号分隔的线程 ID。
- 旧版同步器曾生成缺少 `approval_policy`/`sandbox_policy` 的精简
  `turn_context`，导致 Goal 冷恢复出现解析警告或绕开当前会话配置。同步器现在
  仅在配对侧存在同一 `turn_id` 的完整记录时自动恢复完整 schema，无法证明来源
  的孤立记录保持不动。
- 意外的单侧归档可在确认两个配对 ID 后执行一次
  `CODEX_SYNC_RESTORE_ACTIVE_PAIR_IDS=custom-id,openai-id python3 codex_same.py`。
  同步器会在同一轮备份中保存数据库和待移动 rollout；目标位置存在不同内容时
  会停止，不覆盖任何文件。

设计和验收证据见 [`docs/`](docs/)。安全问题请先阅读
[`SECURITY.md`](SECURITY.md)，不要在公开 Issue 中粘贴数据库、日志或 rollout。

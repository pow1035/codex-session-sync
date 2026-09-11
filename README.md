# Codex Session Sync

同一台 Mac 上，Codex 官方账号登录端与 API/自定义端的本地任务记录默认互不相通——新建的任务"消失"、改名不同步、归档状态错乱、历史任务绑死退役模型。

**codex-session-sync** 解决这个问题：本地、可审计、先备份后写入的双向同步。

> 不是 OpenAI 官方项目。依赖 Codex Desktop 当前的本地 SQLite/JSONL 结构，Codex 升级后请先跑测试再操作真实数据。

## 它做什么

| 痛点 | 解法 |
| --- | --- |
| 新建任务只出现在一端 | 完整回合级双向同步 |
| 一端改名另一端不更新 | 名称同步 + 冲突时隔离不覆盖 |
| 归档任务同步后复活 | 持久 tombstone 双向传播 |
| 历史任务绑退役模型打不开 | 模型配置迁移 |
| 残缺回合被当正常会话传播 | 无最终回复/无用户起点/异常回合一律隔离 |
| 备份塞满磁盘 | 按需备份 + 只留最近一次 |

## 安全模型（核心设计）

同步器以**完整回合**为最小单位，只复制用户可见且可跨 provider 使用的内容：

- **允许**：用户消息、最终助手消息、`task_started`、完整可冷恢复的 `turn_context`、健康的 `task_complete`
- **排除**：reasoning、工具调用、工具输出、压缩上下文、加密状态、provider 专属字段
- **失败即停**：带 `task_complete.error` 的回合留在原端并标记异常——缺失的模型回答不会被 commentary 冒充，不会伪造助手内容
- **冲突不猜**：两端同时独有改动时隔离该任务继续同步其他任务

## 快速开始

```bash
# 要求：macOS + Codex Desktop + Node.js 18+ + Python 3
python3 codex_same.py
```

## 测试

```bash
npm test                    # 单元
npm run test:integration    # 用本机真实 schema 的隔离闭环（临时目录，自动清理）
```

## 已知边界

手动单机同步，不是实时/云端/跨设备；双端真实内容冲突需人工决定；整文件重写操作须先退出 Codex（app-server 运行时工具会拒绝并提示）。完整边界与原理见源 README 与 `SECURITY.md`。

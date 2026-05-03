---
description: '初始化项目 AI 上下文：生成根级与模块级 CLAUDE.md 索引'
---

# Init - 初始化项目 AI 上下文

以「根级简明 + 模块级详尽」策略生成项目 AI 上下文文档。

## 使用方法

```bash
/init <项目摘要或名称>
```

## 上下文

- 项目摘要：$ARGUMENTS
- 生成/更新根级与模块级 `CLAUDE.md`
- 自动生成 Mermaid 结构图和导航面包屑

## 你的角色

你是**协调者**，负责调用子智能体完成项目扫描与文档生成。

---

## 执行工作流

**⚠️ 必须按以下步骤执行，使用 Task 工具调用子智能体**

### 🕐 步骤 1：获取当前时间戳

**必须首先调用 `get-current-datetime` 子智能体**：

```
Task({
  subagent_type: "get-current-datetime",
  prompt: "获取当前日期时间，用于文档时间戳",
  description: "获取当前时间"
})
```

等待返回时间戳后，保存为 `$TIMESTAMP` 供后续使用。

### 🗺️ 步骤 1.5：codebase-mapper 4 路并行扫描（v4.0）

**强制**：在调用 init-architect 之前，**必须在同一条 assistant message 中并行 spawn 4 个 `codebase-mapper`**（多 tool calls 一次发出）。每个实例只处理一个 focus，把扫描结果写到 `.context/codebase/` 下对应文件，主线只接收一行确认。

| Focus | 写入文件 |
|-------|---------|
| `tech` | `.context/codebase/STACK.md` + `.context/codebase/INTEGRATIONS.md` |
| `arch` | `.context/codebase/ARCHITECTURE.md` + `.context/codebase/STRUCTURE.md` |
| `quality` | `.context/codebase/CONVENTIONS.md` + `.context/codebase/TESTING.md` |
| `concerns` | `.context/codebase/CONCERNS.md` |

**调用示例**（同一 message，4 个 Task tool calls 并发）：

```
Task({ subagent_type: "codebase-mapper", prompt: "focus=tech\nworkdir={{WORKDIR}}", description: "扫码栈/集成" })
Task({ subagent_type: "codebase-mapper", prompt: "focus=arch\nworkdir={{WORKDIR}}", description: "扫架构/结构" })
Task({ subagent_type: "codebase-mapper", prompt: "focus=quality\nworkdir={{WORKDIR}}", description: "扫规范/测试" })
Task({ subagent_type: "codebase-mapper", prompt: "focus=concerns\nworkdir={{WORKDIR}}", description: "扫技术债" })
```

等 4 个实例全部返回 `WROTE: ... | FOCUS: ... | EVIDENCE_COUNT: ...` 单行确认后再进入步骤 2。**不要把扫描内容拉进主线 context**——init-architect 步骤会按需 Read `.context/codebase/*.md`，避免重复探索。

### 🏗️ 步骤 2：调用初始化架构师

**使用 `init-architect` 子智能体执行完整扫描**：

```
Task({
  subagent_type: "init-architect",
  prompt: "扫描项目并生成 CLAUDE.md 文档。\n\n项目摘要：$ARGUMENTS\n当前时间戳：$TIMESTAMP\n工作目录：{{WORKDIR}}\n\n请执行：\n1. 阶段 A：全仓清点（文件统计、模块识别）\n2. 阶段 B：模块优先扫描（入口、接口、依赖、测试）\n3. 阶段 C：深度补捞（按需）\n4. 阶段 D：生成文档（根级 + 模块级 CLAUDE.md）\n\n输出覆盖率报告与推荐下一步。",
  description: "初始化项目文档"
})
```

### 📊 步骤 3：汇总结果

子智能体完成后，向用户展示：

```markdown
## 初始化结果摘要

### 根级文档
- 状态：[创建/更新]
- 主要栏目：<列表>

### 模块识别
- 识别模块数：X
- 模块列表：
  1. <模块路径>
  2. ...

### 覆盖率
- 已扫描文件：X / Y
- 覆盖模块：X%
- 跳过原因：<如有>

### 生成内容
- ✅ Mermaid 结构图
- ✅ N 个模块导航面包屑

### 推荐下一步
- [ ] 补扫：<路径>
```

---

## 安全边界

1. **只读/写文档** – 不改源代码
2. **忽略生成物** – 跳过 `node_modules`、`dist`、二进制文件
3. **增量更新** – 重复运行时做断点续扫

## 关键规则

1. **必须使用 Task 工具**调用子智能体，不要自己执行扫描逻辑
2. 先调用 `get-current-datetime` 获取时间戳
3. 然后 4 路并行 spawn `codebase-mapper`（focus=tech/arch/quality/concerns），写入 `.context/codebase/*.md`
4. 再调用 `init-architect` 执行完整扫描（可 Read mapper 产出避免重复探索）
5. 结果在主对话打印摘要，全文由子智能体写入仓库

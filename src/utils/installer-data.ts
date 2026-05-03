import type { WorkflowConfig } from '../types'

// ═══════════════════════════════════════════════════════
// Command builder — adding a new command = 1 function call
// ═══════════════════════════════════════════════════════

type CommandCategory = 'development' | 'init' | 'git' | 'spec'

/**
 * Create a WorkflowConfig with sensible defaults.
 * @param cmdOverride — Use when the slash command name differs from the id (e.g. 'init-project' → 'init')
 */
function cmd(
  id: string,
  order: number,
  category: CommandCategory,
  name: string,
  nameEn: string,
  description: string,
  descriptionEn: string,
  cmdOverride?: string,
): WorkflowConfig {
  return {
    id,
    name,
    nameEn,
    category,
    commands: [cmdOverride ?? id],
    defaultSelected: true,
    order,
    description,
    descriptionEn,
  }
}

// ═══════════════════════════════════════════════════════
// Command registry (source of truth)
// To add a command: append one cmd() call below.
// ═══════════════════════════════════════════════════════

const WORKFLOW_CONFIGS: WorkflowConfig[] = [
  // ── Development ──────────────────────────────────────
  cmd('workflow', 1, 'development', '完整开发工作流', 'Full Development Workflow', '完整6阶段开发工作流（研究→构思→计划→执行→优化→评审）', 'Full 6-phase development workflow'),
  cmd('plan', 1.5, 'development', '多模型协作规划', 'Multi-Model Planning', '上下文检索 + 双模型分析 → 生成 Step-by-step 实施计划', 'Context retrieval + dual-model analysis → Step-by-step plan'),
  cmd('execute', 1.6, 'development', '多模型协作执行', 'Multi-Model Execution', '根据计划获取原型 → Claude 重构实施 → 多模型审计交付', 'Get prototype from plan → Claude refactor → Multi-model audit'),
  // v4.1-p18: team-research / team-plan / team-review 折回 /ccg:team 子命令（独立调用率低），仅保留 team / team-exec
  cmd('team', 1.75, 'development', 'Agent Teams 统一工作流', 'Agent Teams Unified Workflow', '8 阶段企业级工作流（含 research/plan/review 子命令路由）', '8-phase enterprise workflow with research/plan/review sub-commands'),
  cmd('team-exec', 1.9, 'development', 'Agent Teams 并行实施', 'Agent Teams Parallel Execution', '读取计划文件，spawn Builder teammates 并行写代码，需启用 Agent Teams', 'Read plan file, spawn Builder teammates for parallel implementation'),
  cmd('codex-exec', 2.5, 'development', 'Codex 执行计划', 'Codex Plan Executor', '读取 /ccg:plan 计划文件，Codex 全权执行 + 多模型审核', 'Read plan file from /ccg:plan, Codex executes + multi-model review'),
  cmd('context', 2.6, 'development', '项目上下文管理', 'Project Context Manager', '初始化 .context 目录、记录决策日志、压缩归档、查看历史', 'Init .context dir, log decisions, compress, view history'),
  cmd('analyze', 5, 'development', '技术分析', 'Technical Analysis', '双模型技术分析，仅分析不修改代码', 'Dual-model technical analysis, analysis only'),
  cmd('debug', 6, 'development', '问题诊断', 'Debug', '多模型诊断 + 修复', 'Multi-model diagnosis + fix'),
  cmd('optimize', 7, 'development', '性能优化', 'Performance Optimization', '多模型性能优化', 'Multi-model performance optimization'),
  cmd('test', 8, 'development', '测试生成', 'Test Generation', '智能路由测试生成', 'Smart routing test generation'),
  cmd('review', 9, 'development', '代码审查', 'Code Review', '双模型代码审查，无参数时自动审查 git diff', 'Dual-model code review, auto-review git diff when no args'),
  cmd('enhance', 9.5, 'development', 'Prompt 增强', 'Prompt Enhancement', 'ace-tool Prompt 增强工具', 'ace-tool prompt enhancement'),
  cmd('debate', 9.55, 'development', '多轮对辩原语', 'Multi-round Debate', '主线编排 codex propose ↔ gemini challenge ↔ codex respond，cap N 轮或自报无 critical 即停（v4.1 Phase 17）', 'Main-thread orchestrated A↔B multi-round debate (propose/challenge/respond), caps at N rounds or convergence signal'),

  // ── Autonomous & quality gates (v3.0.0+, v4.0 consolidation, v4.1-p18 health/map-codebase 移到 skill) ──
  cmd('autonomous', 1.7, 'development', '跨 phase 自治长跑', 'Autonomous Long-run', '按 .ccg/roadmap.md 顺序执行多 milestone，自动循环 research→plan→exec→review，仅 blocker 暂停', 'Execute roadmap phases autonomously, pause only on blockers'),
  cmd('verify', 9.88, 'development', '统一校验关卡', 'Unified Verify Gate', '按 --gate=change|quality|security|module|all 子门路由（v4.0 整合 4 个 verify-* 命令）', 'Unified verify gate with --gate flag (v4.0 consolidation of 4 verify-* commands)'),
  cmd('verify-work', 9.9, 'development', '变更校验编排器', 'Verify Work Orchestrator', '按变更类型自动选择 verify-{module,security,quality,change} 子门聚合报告', 'Auto-select verify-* gates by change type, aggregate report'),

  // ── Async job triplet (v4.0 Phase 7) ─────────────────
  cmd('status', 9.92, 'development', '后台任务观测', 'Background Job Status', '列出 / 单查 / 阻塞等待 .context/jobs/ 下的后台任务', 'List / inspect / wait on background jobs under .context/jobs/'),
  cmd('result', 9.94, 'development', '取后台任务结果', 'Background Job Result', '读取 .context/jobs/<id>/result.md，输出 ≤ 200 token 摘要', 'Read .context/jobs/<id>/result.md, return ≤ 200 token summary'),
  cmd('cancel', 9.96, 'development', '中止后台任务', 'Cancel Background Job', '写 cancel.flag，子任务下次轮询时协作式退出', 'Write cancel.flag for cooperative cancellation by child task'),

  // ── Init ─────────────────────────────────────────────
  cmd('init-project', 10, 'init', '项目初始化', 'Project Init', '初始化项目 AI 上下文，生成 CLAUDE.md', 'Initialize project AI context, generate CLAUDE.md', 'init'),

  // ── Git ──────────────────────────────────────────────
  cmd('commit', 20, 'git', 'Git 提交', 'Git Commit', '智能生成 conventional commit 信息', 'Smart conventional commit message generation'),
  cmd('rollback', 21, 'git', 'Git 回滚', 'Git Rollback', '交互式回滚分支到历史版本', 'Interactive rollback to historical version'),
  cmd('clean-branches', 22, 'git', 'Git 清理分支', 'Git Clean Branches', '安全清理已合并或过期分支', 'Safely clean merged or stale branches'),
  cmd('worktree', 23, 'git', 'Git Worktree', 'Git Worktree', '管理 Git worktree', 'Manage Git worktree'),

  // ── Spec (OpenSpec / OPSX) ───────────────────────────
  cmd('spec-init', 30, 'spec', 'OpenSpec 初始化', 'OpenSpec Init', '初始化 OpenSpec 环境 + 验证多模型 MCP 工具', 'Initialize OpenSpec environment with multi-model MCP validation'),
  cmd('spec-research', 31, 'spec', '需求研究', 'Spec Research', '需求 → 约束集（并行探索 + OpenSpec 提案）', 'Transform requirements into constraint sets via parallel exploration'),
  cmd('spec-plan', 32, 'spec', '零决策规划', 'Spec Plan', '多模型分析 → 消除歧义 → 零决策可执行计划', 'Refine proposals into zero-decision executable plans'),
  cmd('spec-impl', 33, 'spec', '规范驱动实现', 'Spec Implementation', '按规范执行 + 多模型协作 + 归档', 'Execute changes via multi-model collaboration with spec compliance'),
  cmd('spec-review', 34, 'spec', '归档前审查', 'Spec Review', '双模型交叉审查 → Critical 必须修复 → 允许归档', 'Multi-model compliance review before archiving'),
]

// ═══════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════

export function getWorkflowConfigs(): WorkflowConfig[] {
  return WORKFLOW_CONFIGS.sort((a, b) => a.order - b.order)
}

export function getWorkflowById(id: string): WorkflowConfig | undefined {
  return WORKFLOW_CONFIGS.find(w => w.id === id)
}

/**
 * Get all command IDs for installation.
 * No more presets — always install all commands.
 */
export function getAllCommandIds(): string[] {
  return WORKFLOW_CONFIGS.map(w => w.id)
}

/**
 * @deprecated Use getAllCommandIds() instead.
 * Kept for backward compatibility.
 */
export const WORKFLOW_PRESETS = {
  full: {
    name: '完整',
    nameEn: 'Full',
    description: `全部命令（${WORKFLOW_CONFIGS.length}个）`,
    descriptionEn: `All commands (${WORKFLOW_CONFIGS.length})`,
    workflows: WORKFLOW_CONFIGS.map(w => w.id),
  },
}

export type WorkflowPreset = keyof typeof WORKFLOW_PRESETS

export function getWorkflowPreset(preset: WorkflowPreset): string[] {
  return [...WORKFLOW_PRESETS[preset].workflows]
}

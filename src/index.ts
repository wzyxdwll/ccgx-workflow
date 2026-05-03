// CCG - Claude + Codex + Gemini Multi-Model Collaboration System
export * from './types'
export { init } from './commands/init'
export { showMainMenu } from './commands/menu'
export { update } from './commands/update'
export { i18n, initI18n, changeLanguage } from './i18n'
export {
  readCcgConfig,
  writeCcgConfig,
  createDefaultConfig,
  createDefaultRouting,
  getCcgDir,
  getConfigPath,
} from './utils/config'
export {
  getWorkflowConfigs,
  getWorkflowById,
  installWorkflows,
  installAceTool,
  installAceToolRs,
  uninstallWorkflows,
  uninstallAceTool,
} from './utils/installer'
export {
  migrateToV1_4_0,
  needsMigration,
} from './utils/migration'
export {
  getCurrentVersion,
  getLatestVersion,
  checkForUpdates,
  compareVersions,
} from './utils/version'
export {
  contextPath,
  extractFrontmatter,
  parseFrontmatterFields,
  phaseDir,
  readContext,
  readSummary,
  readSummaryFrontmatter,
  sanitizePhase,
  summaryPath,
  summaryTokenEstimate,
  writeContext,
  writeSummary,
} from './utils/phase-context'
export type { PhaseContext, PhaseSummary } from './utils/phase-context'
export {
  batchByMaxConcurrent,
  buildWaves,
  cascadeSkip,
  parseDependsOn,
  parseRoadmap,
  schedule,
} from './utils/wave-scheduler'
export type {
  PhaseStatus,
  RoadmapPhase,
  ScheduleOptions,
  WaveSchedule,
} from './utils/wave-scheduler'
export {
  parseRoleFlag,
  promptFilePath,
  routeSpecialist,
} from './utils/specialist-router'
export type {
  SpecialistLayer,
  SpecialistModel,
  SpecialistRole,
  SpecialistRoute,
} from './utils/specialist-router'
// v4.1-p19: skill description audit + registry exports
export {
  auditSkillDescriptions,
  auditSkillsDirectory,
  CONTEXT_BUDGET_THRESHOLD,
  DESCRIPTION_SOFT_LIMIT,
  renderAuditMarkdown,
} from './utils/skill-description-audit'
export type { AuditReport, AuditRow } from './utils/skill-description-audit'
export {
  collectInvocableSkills,
  collectSkills,
  generateCommandContent,
  installSkillCommands,
  parseFrontmatter,
} from './utils/skill-registry'
export type { SkillCategory, SkillMeta, SkillRuntimeType } from './utils/skill-registry'
// v4.1-p16: challenger flat orchestration (plugin advisor + specialist critic)
export {
  decideFromSummaries,
  parseChallengerSummary,
  planChallengerSpawns,
  synthesizeRevisionFeedback,
} from './utils/challenger-orchestrator'
export type {
  ChallengeInput,
  ChallengerAgent,
  ChallengerDecision,
  ChallengerPlan,
  ChallengerSummary,
  Finding,
  FindingSeverity,
  PluginAdvisor,
  PluginAvailability,
  SpawnEntry,
  SpecialistCritic,
} from './utils/challenger-orchestrator'
// v4.1-p20: codeagent retirement + plugin detection
export {
  bothPluginsInstalled,
  detectPlugin,
  detectPluginAvailability,
} from './utils/plugin-detection'
export type {
  PluginAvailability as PluginDetectionAvailability,
  PluginDetectionResult,
  PluginName,
} from './utils/plugin-detection'
// v4.2-p21: multi-model routing SSoT
export {
  ALL_LAYERS,
  isLayer,
  ROUTING_SCHEMA_VERSION,
} from './utils/multi-model-routing'
export type {
  Layer,
  Model,
  PluginAvailability as RoutingPluginAvailability,
  Role,
} from './utils/multi-model-routing'

import type { CcgConfig, CollaborationMode, SupportedLang } from '../types'

export interface CliOptions {
  lang?: SupportedLang
  force?: boolean
  skipPrompt?: boolean
  skipMcp?: boolean
  frontend?: string
  backend?: string
  mode?: CollaborationMode
  workflows?: string
  installDir?: string
  /** v4.1-p18: --sync mode, list locally-installed CCG files no longer in templates */
  sync?: boolean
}

export type { CcgConfig, CollaborationMode, SupportedLang }

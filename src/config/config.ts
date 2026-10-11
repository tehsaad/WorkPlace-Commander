import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

import type { Config, WorkspaceFiles } from '../types.ts'
import { mergeConfig, workspaceFiles } from './defaults.ts'
import { findProject, proposeProject, readRegistry, saveProject } from './projects.ts'
import type { ProjectEntry, ProjectMatch } from './projects.ts'

export const PROJECT_CONFIG_NAME = '.workspace-commander.json'

export function userConfigPath(): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  return join(base, 'workspace-commander', 'config.json')
}

export function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return path
}

/** The registry of projects and their workspace folders, next to the user config. */
export function registryPath(): string {
  return join(dirname(userConfigPath()), 'projects.json')
}

/**
 * The git top-level directory of `cwd`, or undefined outside a repository.
 * A linked worktree resolves to its main repository, so every worktree of a
 * repository shares one project.
 */
export function gitRoot(cwd: string): string | undefined {
  try {
    const [top = '', common = ''] = execFileSync(
      'git',
      ['rev-parse', '--show-toplevel', '--path-format=absolute', '--git-common-dir'],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    )
      .trim()
      .split('\n')
    if (!top) return undefined
    return basename(common) === '.git' ? dirname(common) : top
  } catch {
    return undefined
  }
}

function readJson(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined
  } catch (error) {
    throw new Error(`Invalid JSON in ${path}: ${(error as Error).message}`)
  }
}

export interface ResolvedConfig {
  config: Config
  /** The config files that were read, lowest precedence first. */
  sources: string[]
  projectRoot: string
  project: string
  vault: string
  /** Absolute path of the workspace folder inside the vault. */
  workspace: string
  files: WorkspaceFiles
  /** True when `projectRoot` is a git repository (else it is the working directory). */
  isGitRepo: boolean
  /**
   * Where `workspace` came from: `env` (WSC_WORKSPACE_DIR), `config` (a project
   * or explicit config file sets workspaceDir), or `registry` (projects.json;
   * `project.isRegistered` false means it is proposed and saved on first write).
   */
  workspaceSource: 'env' | 'config' | 'registry'
  registration?: ProjectMatch
}

/**
 * Resolves configuration: defaults < user config < project config < WSC_CONFIG / --config.
 * Environment overrides: WSC_VAULT, WSC_WORKSPACE_DIR.
 *
 * The workspace folder is per project: WSC_WORKSPACE_DIR, else a `workspaceDir`
 * from a project or explicit config file, else the project registry
 * (projects.json), else a new `<workspaceDir>/<project>` folder that
 * `{ register: true }` records in the registry.
 */
export function loadConfig(
  cwd: string = process.cwd(),
  explicitPath?: string,
  options: { register?: boolean } = {},
): ResolvedConfig {
  const git = gitRoot(cwd)
  const projectRoot = git ?? resolve(cwd)
  const sources: string[] = []
  const layers: Array<Record<string, unknown> | undefined> = []
  const candidates = [userConfigPath(), join(projectRoot, PROJECT_CONFIG_NAME)]
  const explicit = explicitPath ?? process.env.WSC_CONFIG
  if (explicit) candidates.push(resolve(cwd, expandHome(explicit)))
  let isWorkspacePinned = false
  for (const [index, path] of candidates.entries()) {
    const layer = readJson(path)
    if (layer) {
      layers.push(layer)
      sources.push(path)
      // Only a project or explicit file pins the folder; the user file's
      // workspaceDir is where per-project folders are created.
      if (index > 0 && typeof layer.workspaceDir === 'string') isWorkspacePinned = true
    }
  }
  const env: Record<string, unknown> = {}
  if (process.env.WSC_VAULT) env.obsidianVault = process.env.WSC_VAULT
  if (process.env.WSC_WORKSPACE_DIR) env.workspaceDir = process.env.WSC_WORKSPACE_DIR
  layers.push(env)

  const config = mergeConfig(...layers)
  const vault = resolve(expandHome(config.obsidianVault))
  const folderOf = (dir: string) => (isAbsolute(expandHome(dir)) ? expandHome(dir) : join(vault, dir))
  const base = {
    config,
    sources,
    projectRoot,
    vault,
    files: workspaceFiles(config),
    isGitRepo: git !== undefined,
  }
  if (process.env.WSC_WORKSPACE_DIR || isWorkspacePinned) {
    return {
      ...base,
      project: config.project ?? basename(projectRoot),
      workspace: folderOf(config.workspaceDir),
      workspaceSource: process.env.WSC_WORKSPACE_DIR ? 'env' : 'config',
    }
  }

  const path = registryPath()
  const registry = readRegistry(path)
  const workspacePathOf = (entry: ProjectEntry) => folderOf(entry.workspaceDir)
  let match =
    findProject(registry, projectRoot, { isGitRepo: base.isGitRepo, workspacePathOf }) ??
    proposeProject(registry, projectRoot, config.workspaceDir, config.project)
  if (!match.isRegistered && options.register) match = saveProject(path, projectRoot, match, config.workspaceDir)
  return {
    ...base,
    project: config.project ?? match.entry.name,
    workspace: workspacePathOf(match.entry),
    workspaceSource: 'registry',
    registration: match,
  }
}

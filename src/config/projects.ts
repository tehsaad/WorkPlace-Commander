import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'

import { atomicWrite, withLock } from '../filesystem/atomic.ts'
import { isoNow } from '../events/format.ts'

/**
 * The project registry: which repositories belong to which workspace folder.
 *
 * Every project gets its own folder in the vault, so tasks and messages of one
 * project never mix with another's. Several roots may share one project (git
 * worktrees resolve to their main repository on their own; a second repository
 * joins with `wsc project register --name <existing>`).
 *
 * Lives next to the user config (`~/.config/workspace-commander/projects.json`)
 * and is only ever merged into under a lock, never overwritten wholesale.
 */
export interface ProjectEntry {
  /** Display name, shown in the dashboard and the Markdown headers. */
  name: string
  /** Workspace folder: relative to the vault, or absolute. */
  workspaceDir: string
  /** Absolute directories that resolve to this project. */
  roots: string[]
  registered: string
}

export interface ProjectRegistry {
  version: 1
  projects: Record<string, ProjectEntry>
}

export interface ProjectMatch {
  slug: string
  entry: ProjectEntry
  /** False when the entry is only proposed (not yet in projects.json). */
  isRegistered: boolean
}

const EMPTY: ProjectRegistry = { version: 1, projects: {} }

/** Reads the registry. A missing file is empty; an invalid one throws (it is never replaced). */
export function readRegistry(path: string): ProjectRegistry {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, projects: {} }
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`Invalid JSON in ${path}: ${(error as Error).message}. Fix or move it; it is never overwritten.`)
  }
  const projects = (parsed as { projects?: unknown })?.projects
  if (!projects || typeof projects !== 'object') return { ...EMPTY, projects: {} }
  const out: ProjectRegistry = { version: 1, projects: {} }
  for (const [slug, raw] of Object.entries(projects as Record<string, unknown>)) {
    const e = raw as Partial<ProjectEntry>
    if (!e || typeof e.workspaceDir !== 'string') continue
    out.projects[slug] = {
      name: typeof e.name === 'string' && e.name ? e.name : slug,
      workspaceDir: e.workspaceDir,
      roots: Array.isArray(e.roots) ? e.roots.filter((r): r is string => typeof r === 'string') : [],
      registered: typeof e.registered === 'string' ? e.registered : '',
    }
  }
  return out
}

export function slugify(name: string): string {
  return (
    name
      .normalize('NFKD')
      .replace(/[^\w.-]+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '')
      .toLowerCase() || 'project'
  )
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * Finds the registered project for a directory, nearest match first:
 * 1. a registered root equal to `projectRoot`;
 * 2. the directory sits inside a project's workspace folder (an agent opened
 *    the project's Obsidian folder);
 * 3. outside git only: a registered root that is an ancestor of `projectRoot`,
 *    never the home directory or `/` (those would capture everything).
 */
export function findProject(
  registry: ProjectRegistry,
  projectRoot: string,
  options: { isGitRepo: boolean; workspacePathOf: (entry: ProjectEntry) => string },
): ProjectMatch | undefined {
  const entries = Object.entries(registry.projects)
  for (const [slug, entry] of entries) {
    if (entry.roots.includes(projectRoot)) return { slug, entry, isRegistered: true }
  }
  let best: { slug: string; entry: ProjectEntry; depth: number } | undefined
  const consider = (slug: string, entry: ProjectEntry, dir: string) => {
    const depth = dir.split(sep).length
    if (isInside(projectRoot, dir) && (!best || depth > best.depth)) best = { slug, entry, depth }
  }
  for (const [slug, entry] of entries) consider(slug, entry, options.workspacePathOf(entry))
  if (!options.isGitRepo) {
    const home = homedir()
    for (const [slug, entry] of entries) {
      for (const root of entry.roots) if (root !== home && dirname(root) !== root) consider(slug, entry, root)
    }
  }
  return best ? { slug: best.slug, entry: best.entry, isRegistered: true } : undefined
}

/** A new, not yet saved entry for `projectRoot` with a slug no other project uses. */
export function proposeProject(
  registry: ProjectRegistry,
  projectRoot: string,
  baseDir: string,
  name: string = basename(projectRoot) || 'project',
): ProjectMatch {
  const base = slugify(name)
  let slug = base
  for (let n = 2; registry.projects[slug]; n++) slug = `${base}-${n}`
  const entry: ProjectEntry = {
    name,
    workspaceDir: baseDir ? `${baseDir.replace(/\/+$/, '')}/${slug}` : slug,
    roots: [projectRoot],
    registered: isoNow(),
  }
  return { slug, entry, isRegistered: false }
}

function lockOptions(path: string) {
  return { lockDir: join(dirname(path), 'locks'), staleMs: 10_000 }
}

/**
 * Adds `root` to project `slug` (creating it from `proposed` when absent) under
 * the registry lock. The file is re-read inside the lock, so concurrent
 * registrations merge instead of overwriting each other. Returns the saved
 * match; when another process registered the same root first, that wins.
 */
export function saveProject(path: string, root: string, proposed: ProjectMatch, baseDir: string): ProjectMatch {
  return withLock(path, lockOptions(path), () => {
    const registry = readRegistry(path)
    for (const [slug, entry] of Object.entries(registry.projects)) {
      if (entry.roots.includes(root)) return { slug, entry, isRegistered: true }
    }
    let { slug, entry } = proposed
    const existing = registry.projects[slug]
    if (existing && proposed.isRegistered) {
      entry = { ...existing, roots: [...existing.roots, root] }
    } else if (existing) {
      // A new project whose slug was taken meanwhile gets the next free one.
      ;({ slug, entry } = proposeProject(registry, root, baseDir, proposed.entry.name))
    }
    registry.projects[slug] = entry
    atomicWrite(path, JSON.stringify(registry, null, 2) + '\n')
    return { slug, entry, isRegistered: true }
  })
}

/** Removes `root` from its project. The project's folder and notes are left untouched. */
export function unlinkRoot(path: string, root: string): ProjectMatch | undefined {
  return withLock(path, lockOptions(path), () => {
    const registry = readRegistry(path)
    for (const [slug, entry] of Object.entries(registry.projects)) {
      if (!entry.roots.includes(root)) continue
      // Keep the entry (and its folder mapping) even with no roots left, so
      // re-registering by name finds the same folder again.
      registry.projects[slug] = { ...entry, roots: entry.roots.filter(r => r !== root) }
      atomicWrite(path, JSON.stringify(registry, null, 2) + '\n')
      return { slug, entry: registry.projects[slug]!, isRegistered: true }
    }
    return undefined
  })
}

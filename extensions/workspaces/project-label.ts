/**
 * A branch checkout's project label, `<project> #<conversation>`: a preview served from a checkout this extension made
 * in the project's home (`~/.ultimate/projects/<project>-<hash>/worktrees/<conversation>`). Undefined for other roots.
 */
export function worktreeLabel(root: string) {
  const [, name, id] = /\/\.ultimate\/projects\/(.+)-[\da-f]{8}\/worktrees\/(\d+)$/.exec(root) ?? []
  return name && id ? { name, suffix: `#${id}` } : undefined
}

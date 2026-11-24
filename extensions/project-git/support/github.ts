import { git } from './run.ts'

/** `github.com/<owner>/<repo>`, lowercased, for a GitHub SSH or HTTPS remote URL; undefined for any other. */
export function projectKey(remote: string): string | undefined {
  const match =
    /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/]+@)?github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/*$/i.exec(
      remote.trim(),
    )
  return match ? `github.com/${match[1]}/${match[2]}`.toLowerCase() : undefined
}

/** `github.com/<owner>/<repo>` of the project's `origin`, if it is on GitHub. */
export const githubRepo = (projectRoot: string) =>
  git(projectRoot, 'remote', 'get-url', 'origin')
    .then(projectKey)
    .catch(
      () =>
        // No repository or no origin: the project is not on GitHub, so callers show no GitHub links.
        undefined,
    )

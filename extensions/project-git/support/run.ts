import { exec } from '@ultimate/lib/exec.ts'

/** Where and how long a git command runs; defaults: 30 seconds, 1 MiB of output. `timeout: 0` waits indefinitely. */
export type GitOptions = { cwd: string; timeout?: number; maxBuffer?: number; signal?: AbortSignal }

/** Run git in `cwd` and return its trimmed stdout; a failure rejects with execFile's error, stderr in its message. */
export async function git(cwd: string | GitOptions, ...args: string[]) {
  const options = typeof cwd === 'string' ? { cwd } : cwd
  const { stdout } = await exec('git', args, { timeout: 30000, maxBuffer: 1024 * 1024, ...options })
  return stdout.trim()
}

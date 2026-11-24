import { defineApi } from './extension-api.ts'

/** Optional version-control status for the installed source, not the agent workspace. */
export type SourceStatus = { branch: string; sha: string; dirty: boolean }

/** The host uses this service when it refreshes system status. */
export const SourceStatusApi = defineApi<{
  /** Read the current source status, or return undefined when it is not available. */
  read(): Promise<SourceStatus | undefined>
}>()('ultimate.source-status')

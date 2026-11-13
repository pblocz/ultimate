/** The worktree parts of a child's `subagent` call card, which subagents shows through its points. */
import { GitBranchIcon, GitMergeIcon, Trash2Icon } from 'lucide-react'
import { ToolOutput, ToolSection } from '@/components/ai/tool'
import { cn } from '@/sdk'
import { Tag } from '../subagents/parts.tsx'
import { stateLabel, useWorkspaces } from './data.tsx'
import type { Workspace as Isolate, LandResult } from './types.ts'

function StateTag({ isolate }: { isolate: Isolate }) {
  if (isolate.state === 'ready') return null
  return (
    <Tag
      className={cn(
        'font-mono',
        isolate.state === 'failed' ? 'border-error/40 text-error' : 'text-muted-foreground/70',
      )}
    >
      <span title={isolate.landed ? `Last landed ${isolate.landed.slice(0, 7)}` : undefined}>
        {stateLabel(isolate)}
      </span>
    </Tag>
  )
}

/** The call card's compact workspace: branch and state from the child's summary. */
export function IsolateBadge({ childId }: { childId: number }) {
  const isolate = useWorkspaces()[String(childId)]
  if (!isolate) return null
  return (
    <span
      className="flex items-center gap-1 font-mono"
      title={`${isolate.branch}\n${isolate.path}`}
    >
      <GitBranchIcon className="size-3 shrink-0" />
      <StateTag isolate={isolate} />
    </span>
  )
}

/** The `land` and `discard` actions' JSON result: what landed, at which tip, touching which paths. */
export function Landed({ output }: { output: string }) {
  let result: LandResult
  try {
    result = JSON.parse(output)
  } catch {
    return <ToolOutput output={output} />
  }
  if (!result.landed)
    return (
      <ToolSection>
        <p className="flex items-center gap-1.5 text-muted-foreground">
          <Trash2Icon className="size-3 shrink-0" />
          {result.text}
        </p>
      </ToolSection>
    )
  const commits = result.commits ?? []
  const files: { path: string; added?: number; removed?: number }[] =
    result.files ?? result.paths?.map((path) => ({ path })) ?? []
  const added = files.reduce((sum, file) => sum + (file.added ?? 0), 0)
  const removed = files.reduce((sum, file) => sum + (file.removed ?? 0), 0)
  return (
    <>
      <ToolSection className="border-l-2 border-l-success/70">
        <p className="flex items-center gap-1.5 text-success">
          <GitMergeIcon className="size-3 shrink-0" />
          {commits.length
            ? `Landed ${result.landed.slice(0, 7)} · ${commits.length} commit${commits.length === 1 ? '' : 's'}`
            : 'Nothing new to land'}
        </p>
        {result.needsRestart && (
          <p className="text-warning">Needs restart to apply core or package changes.</p>
        )}
      </ToolSection>
      {commits.length > 0 && (
        <ToolSection label="Commits">
          <ul className="space-y-0.5">
            {commits.map((commit) => (
              <li className="truncate" key={commit} title={commit}>
                <span className="text-muted-foreground">{commit.split(' ')[0]}</span>{' '}
                {commit.slice(commit.indexOf(' ') + 1)}
              </li>
            ))}
          </ul>
        </ToolSection>
      )}
      {files.length > 0 && (
        <ToolSection>
          <div className="flex items-center gap-2 section-label">
            {files.length} changed file{files.length === 1 ? '' : 's'}
            {result.files && (
              <span>
                <span className="text-diff-add">+{added}</span>{' '}
                <span className="text-diff-del">−{removed}</span>
              </span>
            )}
          </div>
          <ul className="space-y-0.5">
            {files.map((file) => {
              const slash = file.path.lastIndexOf('/') + 1
              return (
                <li className="flex min-w-0 items-center gap-2" key={file.path} title={file.path}>
                  <span className="min-w-0 flex-1 truncate">
                    <span className="text-muted-foreground">{file.path.slice(0, slash)}</span>
                    {file.path.slice(slash)}
                  </span>
                  {'added' in file && (
                    <span className="shrink-0 tabular-nums">
                      <span className="text-diff-add">+{file.added}</span>{' '}
                      <span className="text-diff-del">−{file.removed}</span>
                    </span>
                  )}
                </li>
              )
            })}
          </ul>
        </ToolSection>
      )}
    </>
  )
}

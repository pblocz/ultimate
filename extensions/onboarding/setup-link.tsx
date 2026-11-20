import { FolderCogIcon, GitBranchIcon } from 'lucide-react'
import { useState } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { errorMessage, Provided, useUltimate } from '@/sdk'
import { SetupWorkflow } from './points.tsx'

/**
 * A status-line link to finish the project or Git setup: it asks the coding workflow's primary agent for help, or opens
 * the Extensions panel when onboarding is off or no workflow provides help.
 */
export function SetupLink(props: { card: 'project' | 'git'; off?: boolean; children: string }) {
  return (
    <Provided input={null} point={SetupWorkflow}>
      {(workflow) => <Link {...props} help={props.off ? undefined : workflow?.help} />}
    </Provided>
  )
}

function Link({
  card,
  help,
  children,
}: {
  card: 'project' | 'git'
  help?: (card: 'project' | 'git') => Promise<number>
  children: string
}) {
  const ui = useUltimate()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const click = async () => {
    if (busy) return
    // Without help, the decision is the user's own: the Extensions panel shows it.
    if (!help) return ui.openPanel('extensions')
    setBusy(true)
    try {
      ui.switchConversation(await help(card))
      ui.showSurface('agent')
      setError(undefined)
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setBusy(false)
    }
  }
  const Icon = card === 'project' ? FolderCogIcon : GitBranchIcon
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          disabled={busy}
          className="-mx-1 flex items-center gap-1.5 rounded-sm px-1 transition-colors hover:bg-accent hover:text-foreground"
          onClick={() => void click()}
          type="button"
        >
          <Icon className="size-3 text-brand" />
          {error ?? children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="text-[11px]">
        {error ??
          (help ? 'Ask @ultimate for help with this folder.' : "Decide on this project's setup.")}
      </TooltipContent>
    </Tooltip>
  )
}

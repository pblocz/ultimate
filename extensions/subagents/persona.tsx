import { CheckIcon, ChevronDownIcon, UserRoundIcon } from 'lucide-react'
import { useState } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  api,
  cn,
  errorMessage,
  useAction,
  useConversation,
  useConversationSummary,
  useDocOf,
} from '@/sdk'
import { DefinitionsAction, ProfileDoc } from './refs.ts'

const toolbarButton =
  'flex h-7 max-w-48 min-w-0 shrink items-center gap-1.5 rounded-md px-2 font-mono text-[11.5px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground'
const row =
  'flex h-7 w-full items-center gap-2 rounded-sm px-2 text-left text-[12px] transition-colors hover:bg-accent disabled:opacity-50'

/**
 * The persona of an ordinary conversation: one of the existing agent definitions, or none. The model control stays
 * separate, so a persona keeps the chosen preset unless the definition itself sets a model.
 */
export function PersonaButton() {
  const { id, busy, loading } = useConversation()
  const ordinary = useConversationSummary(id)?.label === 'chat'
  const selected = useDocOf(ordinary ? id : undefined, ProfileDoc)?.definition
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string>()
  const { data } = useAction(DefinitionsAction, null, {
    enabled: ordinary,
    onError: (failure) => setError(errorMessage(failure)),
  })
  if (!ordinary) return null
  const choose = (definition: string | null) => {
    setError(undefined)
    api.configure({ definition }, id).then(
      () => setOpen(false),
      (failure: unknown) => setError(errorMessage(failure)),
    )
  }
  const definitions = data?.definitions ?? []
  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <button
          aria-label="Persona"
          className={toolbarButton}
          disabled={loading}
          title={selected ? `Persona: ${selected}` : 'No persona'}
          type="button"
        >
          <UserRoundIcon className={cn('size-3.5 shrink-0', selected && 'text-brand')} />
          <span className={cn('truncate', selected && 'text-foreground/85')}>
            {selected ?? 'No persona'}
          </span>
          <ChevronDownIcon className="size-3 shrink-0 opacity-60 @max-md:hidden" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="max-h-80 w-72 overflow-y-auto p-1 font-mono"
        side="top"
      >
        <div className="px-2 pt-1 pb-1.5 section-label">Persona</div>
        <button className={row} disabled={busy} onClick={() => choose(null)} type="button">
          <CheckIcon className={cn('size-3.5 shrink-0', selected && 'opacity-0')} />
          No persona
        </button>
        {definitions.map((definition) => (
          <button
            className={cn(row, definition.name === selected && 'text-brand')}
            disabled={busy}
            key={definition.name}
            onClick={() => choose(definition.name)}
            title={definition.description}
            type="button"
          >
            <CheckIcon
              className={cn('size-3.5 shrink-0', definition.name !== selected && 'opacity-0')}
            />
            <span className="shrink-0">{definition.name}</span>
            <span className="min-w-0 truncate font-sans text-[11px] text-muted-foreground">
              {definition.description}
            </span>
          </button>
        ))}
        <div className="mt-1 border-t border-border/70 px-2 pt-1.5 pb-1 text-[11px] text-muted-foreground">
          {error ? (
            <span className="text-error">{error}</span>
          ) : busy ? (
            'Wait for the current turn to change the persona.'
          ) : (
            'Applies its instructions, tools and model settings.'
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

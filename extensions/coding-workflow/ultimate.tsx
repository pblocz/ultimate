import { Provided } from '@/sdk'
import { ConversationPhase } from '@ultimate/ext/conversations/ui.tsx'

/** A busy standing agent's working phase in the sidebar. */
export function StandingPhase({ id }: { id: number }) {
  return (
    <Provided input={id} point={ConversationPhase}>
      {(phase) => (
        <span className="shrink-0 text-brand">
          {phase && !phase.waiting ? phase.word : 'working'}
        </span>
      )}
    </Provided>
  )
}

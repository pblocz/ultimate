The Agent surface's sidebar: the ordinary conversation list with **New conversation**, and the points that let other
extensions add sections to the sidebar. It depends on no other extension. The coding workflow's project tree is a
separate section of the `sidebar` slot (`extensions/coding-workflow/README.md`).

## Ordinary conversations

The list (`OrdinaryConversations`, `ordinary.tsx`) is the last section of the sidebar, under the other sections: the
coding workflow's project tree stretches above it. It shows the conversations that
the user created as chats (`isChat`, `chats.ts`): the shared create operation marks them with the `chat` label, and a
chat has no parent and is not a branch. Branches, subagents, side chats, standing agents and internal records do not
show here. The latest activity (input or answer) comes first; empty new chats sort by their creation order.

Each row has a dot that pulses while the conversation works, its title (`Untitled conversation` until it has one) and
the age of its latest activity. The shown row is marked with `aria-current="page"`; beside another surface (Memory) no
row is marked. **New conversation** above the list runs the `ultimate.new` command: it creates a chat and shows it.

Under it, the list folds into a collapsible **Conversations** header with the count (`Section`, `section.tsx`): open
unless folded, the fold kept per user in `ext.conversations.closedSections`.

## A folding section

`section.tsx` is the sidebar's shared collapsible section: a quiet mono heading with a count bubble, and its rows. The
coding workflow's In flight and Landed sections use it too (`@ultimate/ext/sidebar/section.tsx`).

## Where a page opens

`OpenLatest` (an overlay) opens a conversation only when none is selected, on a first load or when the remembered one
is gone (`landing`, `chats.ts`). It opens the latest ordinary chat. When there is no chat, the empty new-chat screen
stays. It never creates `@ultimate`, starts a model turn, or selects the internal root (conversation 1).

## Points

`ui.tsx` exports `useShell` and `useSidebarState` (`state.tsx`: switch conversations and surfaces, run commands) and two
points for other sidebar sections:

- `sidebar.unlisted` (`Unlisted`): conversations that no other section lists. The sidebar provides it with the ordinary
  chats, so the coding tree leaves them to this list. `side-chat` and `voice-live` provide their own conversations.
- `sidebar.under-ultimate` (`UnderUltimate`): rows that the coding tree nests under `@ultimate`'s row.

The UI state keys keep the names they had as part of conversations (`ext.conversations.*`).

---
name: maintain-ultimate
description: Explain how Ultimate works, or change Ultimate itself, with its docs, reload rules and restart rules. Use when someone is new to Ultimate or asks how it works, before you change the installed application or its extensions, and before you call restart.
---

The environment section of your system prompt names the installed application: that folder is Ultimate's source.
When the shared workspace is Ultimate itself and your conversation has its own workspace, use that workspace's copy.

When someone is new to Ultimate or asks how it works, guide them from README.md (what it is, how to start, what to
try) and the "How work is organised" section of AGENTS.md (roots, branches, notes, landing) in that folder: explain
briefly, in their terms, and point at the UI they will use (@ultimate's row at the top of the sidebar, or the top-bar
@ultimate button on phones, and its conversation, Ctrl+K or ⌘K commands, the right panel).

Before changing Ultimate, read AGENTS.md (layers, reloads, durability) and extensions/README.md (new UI is a new
extension folder; it indexes the topic files in docs/extensions/) in that folder.

UI and extension changes in the running host reload live. Call restart only after a landing that changed server/,
shared/, patches/ or pnpm-lock.yaml, never for web/, extensions/, or agents/.

When your conversation has its own workspace, land it into its source first; restart requires the running clone to be
clean at that landed commit.

/**
 * Onboarding for other extensions' browser code: the first-run status, starting onboarding, extension switches, and
 * the points the coding workflow fills (its onboarding start and help, and the Git setup card).
 */
export {
  ChooseAction,
  DismissAction,
  HelpAction,
  SetExtensionAction,
  StartAction,
  StartsDoc,
  StatusAction,
  WalkthroughAction,
} from './refs.ts'
export { firstRunDialog } from './parts.tsx'
export { onboarded } from './onboarded.ts'
export { SetupLink } from './setup-link.tsx'
export { ExtensionDetails, SetupCard, SetupWorkflow } from './points.tsx'

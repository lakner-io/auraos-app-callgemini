import { createLifecycleHandler } from '@aura/app-sdk';
// @ts-expect-error — plain .mjs module shared with the WS bridge (no d.ts).
import { closeAllSessions } from '../../../server/sessions.mjs';

// The WS bridge and these routes run in the same app process, so we can reach
// the live-session registry directly. Close any active call when the OS stops us.
export const POST = createLifecycleHandler('onStop', () => {
  closeAllSessions('onStop');
});

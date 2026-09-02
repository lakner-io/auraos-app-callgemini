import { createLifecycleHandler } from '@aura/app-sdk';
// @ts-expect-error — plain .mjs module shared with the WS bridge (no d.ts).
import { closeAllSessions } from '../../../server/sessions.mjs';

export const POST = createLifecycleHandler('onDestroy', () => {
  closeAllSessions('onDestroy');
});

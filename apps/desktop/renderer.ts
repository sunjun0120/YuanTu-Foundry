import '@mantine/core/styles.css';
import { mountDesktopApp } from './ui/App.tsx';
import { connectDesktop } from './ui/application.tsx';
import { createDesktopRuntime } from './ui/runtime.ts';
import type { DesktopActions } from './ui/actions.ts';

const runtime = createDesktopRuntime(window.yuantu);
let application: ReturnType<typeof connectDesktop> | undefined;
const actions: DesktopActions = {
  invoke: (command) => application?.actions.invoke(command) ?? Promise.resolve(null),
  select: (command) => application?.actions.select(command) ?? Promise.resolve(null),
};
const unmount = mountDesktopApp({
  runtime,
  actions,
  initialize: () => {
    const connected = connectDesktop(runtime);
    application = connected;
    connected.start();
    return () => {
      connected.dispose();
      if (application === connected) application = undefined;
    };
  },
});
window.addEventListener(
  'pagehide',
  () => {
    try {
      unmount();
    } finally {
      runtime.dispose();
    }
  },
  { once: true },
);

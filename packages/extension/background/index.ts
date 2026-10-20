import { initCapture } from "./capture"
import { initCdp } from "./cdp"
import { installDialogGuard } from "./dialogs"
import { initHandoff } from "./handoff"
import { initNotify } from "./notify"
import { connectHost } from "./native-port"
import { listenRecorder } from "./recorder"
import { recordGuardDialog, route } from "./rpc-router"
import { loadSessions, watchTabs } from "./sessions"
import { listenUi } from "./ui"

// Listeners must be registered synchronously at service-worker start.
watchTabs()
initCdp()
installDialogGuard((tabId, dialog) =>
  void recordGuardDialog(tabId, dialog).catch((e: unknown) => console.warn("[kite] dialog not recorded", e)),
)
initCapture()
initHandoff()
initNotify()
listenUi()
listenRecorder()
void loadSessions()

const host = connectHost((m) => {
  void route(m).then((res) => host.send(res))
})

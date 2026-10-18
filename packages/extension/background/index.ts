import { initCapture } from "./capture"
import { initCdp } from "./cdp"
import { installDialogGuard } from "./dialogs"
import { connectHost } from "./native-port"
import { route } from "./rpc-router"
import { loadSessions, watchTabs } from "./sessions"
import { listenUi } from "./ui"

// Listeners must be registered synchronously at service-worker start.
watchTabs()
initCdp()
installDialogGuard()
initCapture()
listenUi()
void loadSessions()

const host = connectHost((m) => {
  void route(m).then((res) => host.send(res))
})

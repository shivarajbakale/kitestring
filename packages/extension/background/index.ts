import { connectHost } from "./native-port"
import { route } from "./rpc-router"
import { loadSessions, watchTabs } from "./sessions"

// Listeners must be registered synchronously at service-worker start.
watchTabs()
void loadSessions()

const host = connectHost((m) => {
  void route(m).then((res) => host.send(res))
})

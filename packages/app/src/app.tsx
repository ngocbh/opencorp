import { Route, Router } from "@solidjs/router"
import Pair from "./pages/pair"

/** The HQ app's routes. */
export function App() {
  return (
    <Router>
      <Route path="/pair" component={Pair} />
      <Route path="*" component={() => <main class="p-6 text-lg font-semibold">OpenCorp HQ</main>} />
    </Router>
  )
}

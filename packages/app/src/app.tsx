import { Route, Router } from "@solidjs/router"
import { lazy } from "solid-js"
import { OfficeProvider } from "./data/office"
import Pair from "./pages/pair"
import SignIn from "./pages/sign-in"

// Lazy, so a rebuild that deletes this chunk fails as a missing script and the app checks its version.
const Company = lazy(() => import("./pages/company"))

/** The company view with the office around it, at "/" and any other path. */
const Office = () => (
  <OfficeProvider>
    <Company />
  </OfficeProvider>
)

/** The HQ app's routes. */
export function App() {
  return (
    <Router>
      <Route path="/pair" component={Pair} />
      <Route path="/sign-in" component={SignIn} />
      <Route path="/" component={Office} />
      <Route path="*" component={Office} />
    </Router>
  )
}

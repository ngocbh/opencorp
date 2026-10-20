import { Route, Router, type RouteSectionProps } from "@solidjs/router"
import { lazy } from "solid-js"
import { OfficeProvider } from "./data/office"
import Pair from "./pages/pair"
import SignIn from "./pages/sign-in"
import { Shell } from "./shell"

// Lazy, so a rebuild that deletes this chunk fails as a missing script and the app checks its version.
const Company = lazy(() => import("./pages/company"))

/** The office and the shell around every screen: a parent route, so moving between screens keeps one office. */
const Office = (props: RouteSectionProps) => (
  <OfficeProvider>
    <Shell>{props.children}</Shell>
  </OfficeProvider>
)

/** The HQ app's routes. */
export function App() {
  return (
    <Router>
      <Route path="/pair" component={Pair} />
      <Route path="/sign-in" component={SignIn} />
      <Route path="/" component={Office}>
        <Route path="/" component={Company} />
        <Route path="*" component={Company} />
      </Route>
    </Router>
  )
}

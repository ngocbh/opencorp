import { Navigate, Route, Router, type RouteSectionProps } from "@solidjs/router"
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

/** What an address inside the shell with no screen shows. */
const NoPage = () => <p class="p-6">There's no page here.</p>

/** The HQ app's routes. */
export function App() {
  return (
    <Router>
      <Route path="/pair" component={Pair} />
      <Route path="/sign-in" component={SignIn} />
      <Route path="/" component={Office}>
        {/* The home screen until there's an Inbox; old bookmarks of / land here too. */}
        <Route path="/" component={() => <Navigate href="/org" />} />
        <Route path="/org" component={Company} />
        <Route path="*" component={NoPage} />
      </Route>
    </Router>
  )
}

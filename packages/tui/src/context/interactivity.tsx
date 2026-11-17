import { createContext, createMemo, useContext, type Accessor, type ParentProps } from "solid-js"

const Context = createContext<Accessor<boolean>>(() => true)

/** Disabling a subtree also disables every nested interactivity provider. */
export function InteractivityProvider(props: ParentProps<{ enabled: boolean }>) {
  const parent = useInteractivity()
  const enabled = createMemo(() => parent() && props.enabled)
  return <Context.Provider value={enabled}>{props.children}</Context.Provider>
}

/** Shared by keymap consumers and native input/focus handlers. Defaults to enabled. */
export function useInteractivity() {
  return useContext(Context)
}

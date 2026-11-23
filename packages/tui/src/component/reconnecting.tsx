import { RGBA } from "@opentui/core"
import { useTheme } from "../context/theme"
import { Spinner } from "./spinner"

/** A full-screen overlay saying the office's connection was lost and is being retried, with why the office's state
 *  can't be read when `error` says. With no office (`local`), it names the session instead. */
export function Reconnecting(props: { error?: string; local?: boolean }) {
  const { theme } = useTheme()

  return (
    <box
      position="absolute"
      zIndex={10_000}
      top={0}
      right={0}
      bottom={0}
      left={0}
      backgroundColor={RGBA.fromInts(0, 0, 0, 150)}
      alignItems="center"
      justifyContent="center"
    >
      <box
        width={48}
        maxWidth="90%"
        flexDirection="column"
        backgroundColor={theme.backgroundPanel}
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={2}
        gap={1}
      >
        <Spinner color={theme.text}>Connection lost…</Spinner>
        <text fg={theme.textMuted}>
          {props.error !== undefined
            ? `${props.local ? "The session's" : "The office's"} state can't be read: ${props.error}. Retrying…`
            : `Reconnecting to ${props.local ? "the session" : "the office"} automatically.`}
        </text>
      </box>
    </box>
  )
}

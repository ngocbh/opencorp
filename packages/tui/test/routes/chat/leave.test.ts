import { expect, test } from "bun:test"
import { leaveBindings, pressTwice } from "../../../src/routes/chat/leave"

test("pressTwice is true only for a second press within the window", () => {
  let t = 0
  const press = pressTwice(5000, () => t)
  expect(press()).toBe(false)
  t = 4000
  expect(press()).toBe(true)
  t = 5000
  expect(press()).toBe(false)
  t = 11000
  expect(press()).toBe(false)
  t = 11001
  expect(press()).toBe(true)
})

test("leaveBindings sends the exit keys to app.leave, except leader chords, which still exit", () => {
  expect(leaveBindings([{ key: "ctrl+c,ctrl+d, <leader>q", cmd: "app.exit", desc: "Exit" }])).toEqual([
    { key: "ctrl+c", cmd: "app.leave", desc: "Exit" },
    { key: "ctrl+d", cmd: "app.leave", desc: "Exit" },
    { key: "<leader>q", cmd: "app.exit", desc: "Exit" },
  ])
  const stroke = { name: "q", ctrl: true }
  expect(leaveBindings([{ key: stroke, cmd: "app.exit" }])).toEqual([{ key: stroke, cmd: "app.leave" }])
})

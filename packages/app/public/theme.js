// Sets data-theme before the app loads, so the page doesn't flash the wrong theme.
;(() => {
  let saved = null
  try {
    saved = localStorage.getItem("hq.theme")
  } catch {
    // Storage blocked (a privacy setting, say): follow the system.
  }
  const dark = saved ? saved === "dark" : matchMedia("(prefers-color-scheme: dark)").matches
  document.documentElement.dataset.theme = dark ? "dark" : "light"
})()

// Sets data-theme before the app loads, so the page doesn't flash the wrong theme.
;(() => {
  const saved = localStorage.getItem("hq.theme")
  const dark = saved ? saved === "dark" : matchMedia("(prefers-color-scheme: dark)").matches
  document.documentElement.dataset.theme = dark ? "dark" : "light"
})()

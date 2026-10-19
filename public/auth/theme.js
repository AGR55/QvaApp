// Apply the saved theme before styles paint, without inline scripts or styles.
let qvaTheme;
try {
  qvaTheme = window.localStorage.getItem("qvaapply-theme");
} catch {
  // Follow the system when browser storage is unavailable.
}
document.documentElement.dataset.theme = qvaTheme === "light" || qvaTheme === "dark"
  ? qvaTheme
  : window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";

// Public page themes. Each one ships a light and a dark variant that follows the
// visitor's color-scheme preference. Redirect pages never render a theme.
export const themes = [
  { id: 'default', label: 'Default', description: 'Soft cards with link previews' },
  { id: 'cv', label: 'CV', description: 'Typographic list in IBM Plex Sans' },
] as const;
export type ThemeId = (typeof themes)[number]['id'];
export const themeIds = themes.map((t) => t.id) as [ThemeId, ...ThemeId[]];

// Public page themes. Each one ships a light and a dark variant that follows the
// visitor's color-scheme preference. Redirect pages never render a theme.
// card holds the light colors of the page's share image (server/cards.ts), which cannot
// follow the viewer's color scheme; tests check them against the --pg-* tokens.
export const themes = [
  {
    id: 'default',
    label: 'Default',
    description: 'Soft cards with link previews',
    card: { bg: '#f5f3fa', border: '#e6e0ef', ink: '#222734', muted: '#8b859b' },
  },
  {
    id: 'cv',
    label: 'CV',
    description: 'Typographic list in IBM Plex Sans',
    card: { bg: '#fff', border: '#dcd7d5', ink: '#231f20', muted: '#6b6566' },
  },
] as const;
export type ThemeId = (typeof themes)[number]['id'];
export const themeIds = themes.map((t) => t.id) as [ThemeId, ...ThemeId[]];

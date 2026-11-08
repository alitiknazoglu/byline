# Social assets

| File | Size | Use |
| --- | --- | --- |
| `logo.png` | 1024×1024, transparent corners | The mark on its own (same drawing as the favicon) |
| `logo-avatar.png` | 1024×1024, full-bleed | Profile pictures; survives a circle crop |
| `logo-wordmark-dark.png` | 1200×400, transparent | Mark + "byline" for dark backgrounds |
| `logo-wordmark-light.png` | 1200×400, transparent | Mark + "byline" for light backgrounds |
| `preview.png` | 1200×630 | Website preview (Open Graph / X card); served as `/og.png` |

The sources are HTML in `src/`. To re-render after editing them:

```bash
socials/render.sh
```

```bash
cp socials/preview.png apps/web/public/og.png
```

`render.sh` needs a Chromium-based browser (Playwright's headless shell, Chrome, Brave or Chromium); set `BROWSER=/path/to/chrome` to pick one.

# Brand assets

The assets in `public/brand/` are Yarnoo's, taken from the Yarnoo Brand Playbook
and its source vector files.

| File | What | Where it is used |
|---|---|---|
| `yarnoo-logo-white.svg` | horizontal lockup, white | navbar on every page, projector |
| `yarnoo-logo-magenta.svg` | horizontal lockup, Spotlight Magenta | for light grounds |
| `yarnoo-logo-stacked-*.svg` | stacked lockup | spare |
| `yarnoo-logo-descriptor-*.svg` | lockup with "Your directory to Arab talent" | spare |
| `yarnoo-logo-arabic-*.svg` | Arabic lockup | spare |
| `yarnoo-mark-white.svg` | the Yarnoo Mark alone, white | page supergraphic |
| `yarnoo-mark-magenta.svg` | the Yarnoo Mark alone, magenta | wheel hub, sign-in button |
| `yarnoo-icon.svg`, `favicon-32.png`, `apple-touch-icon.png` | white mark on a magenta rounded square | browser tab, home screen |
| `yarnoo-icon-192.png` | the same icon at 192px | spare - for a web manifest; none is wired |
| `fonts/bricolage-grotesque-72pt-bold.woff2` | headline face | `style.css` |
| `fonts/onest-{400,500,600,700,800}.woff2` | text face | `style.css` |

The SVGs are the Playbook's own vector files (`Yarnoo-06`, `-02`, `-04`,
`-08-arabic`, `-10`), recoloured to a single fill and **cropped to the artwork**:
the sources sit in the middle of a 1080 x 1080 canvas, and served uncropped the
empty canvas shrinks the logo to a speck inside its box. The fonts are the
brand's TTFs converted to woff2, unmodified.

Logo rules from the Playbook: white on magenta, photos and dark grounds;
original magenta on light grounds; never magenta on magenta; never smaller than
**55px tall** on screen; keep clear space of at least the mark's small triangle
on every side.

`/brand/` is served with a 24-hour cache, unlike the rest of `public/`. Replace
an asset under a **new filename** and update the reference, or phones that
loaded the old one keep it for a day. If the logo file is ever missing, every
page falls back to a text wordmark, so nothing breaks.

# Desktop icons

SVG source assets live here and are copied to `dist/desktop/assets/icons` by
`scripts/build-desktop.mjs`. Use `ui/icons/AssetIcon.tsx` for single-color icons;
its SVG mask inherits the surrounding text color, including dark mode.

The Figma SVGs and `manifest.json` were copied from the reference project
`E:/agent-desktop/yangshi/yuantu-foundry/public/assets/figma`.
`sliders-horizontal`, `cpu`, `sun`, `moon`, `monitor`, and `x` were extracted from
that project's `@lucide/vue` 1.61.0 icon data. Their license is retained in
`LUCIDE-LICENSE.txt`. No Vue runtime dependency is needed by desktop.

Brand assets contain multiple shapes/colors and should be rendered as images
instead of single-color masks.

# pflow.xyz Landing Page Rebuild

## Current State

pflow.xyz drops visitors directly into the Petri net editor with a random model. First-time visitors have no context for what they're looking at. The site gets 263 page views / 58 visitors per month (Google Analytics, 30 days as of Mar 7 2026) and has 30 indexed pages in Google Search Console.

The old pitch-style landing page lived in `pflow-xyz/pflow-react-dev` (now archived/deprecated). It was a React + MUI app with a "Web3 SDK for Visual State Machines" framing that no longer fits. The visual assets from that era are worth preserving.

## Goal

Add a landing hero to pflow.xyz that explains what it is, shows what it can do, and gets visitors into the editor fast. Keep it vanilla JS/HTML — no React, no npm. The editor remains the core experience; the landing page is a front door, not a replacement.

## Design Direction

### Visual Identity (from pflow-react-dev)

Dark background with neon yellow accents. Pixel-art aesthetic.

- **Color palette:** `#1C1C1D` / `#1E1E1D` (backgrounds), `#EBFF00` (neon yellow accent), `#FFFFFF` (text)
- **Font:** GT_America-Light (used throughout old site) — check licensing, may need a fallback like Inter or system fonts
- **Logo:** Pixel-art "pflow" wordmark — SVG path data in `LogoCard.tsx` component
- **Flower motif:** Pixel-art flower used as decoration — SVG path data in `FlowerBar.tsx`

### Assets to Extract from pflow-react-dev

Repo: `github.com/pflow-xyz/pflow-react-dev` (archived)

| Asset | Location | Usage |
|-------|----------|-------|
| p-flower.mp4 | `webui/public/p-flower.mp4` | Background video animation (looping flower bloom). Convert to WebM for smaller size, or extract keyframes as animated SVG/CSS |
| snowcrash.mp4 | `webui/public/snowcrash.mp4` | Secondary background animation |
| Flower bar SVG | `webui/src/components/FlowerBar.tsx` | Decorative pixel-art flower strip (inline SVG paths) |
| Logo SVG paths | `webui/src/components/LogoCard.tsx` | Pixel-art pflow logo + flower icon (213x260 viewBox) |
| Pixel font paths | `webui/src/components/FlowerBar.tsx` | "pflow" text rendered as SVG pixel paths |
| dining-philosophers.svg | `webui/public/dining-philosophers.svg` | Example Petri net diagram |
| Favicon set | `webui/public/` | android-chrome, apple-touch-icon, favicon, mstile, safari-pinned-tab (already duplicated in current pflow-xyz) |

### Extracting Assets

```bash
# Clone the archived repo (read-only)
git clone git@github.com:pflow-xyz/pflow-react-dev.git /tmp/pflow-react-dev

# Copy video assets
cp /tmp/pflow-react-dev/webui/public/p-flower.mp4 public/
cp /tmp/pflow-react-dev/webui/public/snowcrash.mp4 public/

# Copy example SVG
cp /tmp/pflow-react-dev/webui/public/dining-philosophers.svg public/

# Extract SVG components manually from:
#   webui/src/components/FlowerBar.tsx  -> flower-bar.svg
#   webui/src/components/LogoCard.tsx   -> logo-card.svg
# These are inline JSX SVGs — copy the <path> elements into standalone .svg files

rm -rf /tmp/pflow-react-dev
```

## Landing Page Structure

### Layout

```
+--------------------------------------------------+
|  [pflow logo]                        [Launch Editor] |
+--------------------------------------------------+
|                                                    |
|   p-flower.mp4 background (looped, muted)         |
|                                                    |
|        "Visual Editor for Petri Nets"              |
|                                                    |
|     [ Try the Editor ]  [ Read the Book ]          |
|                                                    |
+--------------------------------------------------+
|                                                    |
|   Example Models (clickable cards)                 |
|                                                    |
|   [Coffeeshop]  [Tic-Tac-Toe]  [Token Model]     |
|   [Sudoku]      [Enzyme Kinetics] [Texas Holdem]  |
|                                                    |
|   Each card: SVG thumbnail + title + one-liner     |
|   Click -> opens model in editor                   |
|                                                    |
+--------------------------------------------------+
|                                                    |
|   Ecosystem Links                                  |
|                                                    |
|   blog.stackdump.com  - Technical blog             |
|   book.pflow.xyz      - The Petri Nets Book        |
|   pilot.pflow.xyz     - AI code generation         |
|   github.com/pflow-xyz - Source code               |
|                                                    |
+--------------------------------------------------+
|  flower-bar.svg decoration                         |
|  (c) Stackdump.com LLC                             |
+--------------------------------------------------+
```

### Implementation Notes

1. **Single HTML file with inline CSS** — add a `<section id="landing">` before the existing `<petri-view>` element in `public/index.html`. The editor markup stays untouched.

2. **Show/hide logic** — landing page shows on first visit or when navigating to `/`. Clicking "Try the Editor" or any model card hides the landing section and reveals the editor. Store preference in `localStorage` so returning users skip straight to the editor.

3. **Video background** — use `<video autoplay loop muted playsinline>` with `p-flower.mp4`. Set `object-fit: cover` and position absolute behind the hero text. Add a dark overlay (`rgba(0,0,0,0.6)`) so text remains readable. Consider `prefers-reduced-motion` media query to disable for accessibility.

4. **Model cards** — each card loads a model URL into the editor. The editor already supports loading models via URL (`?url=...` or the Open URL feature). Generate SVG thumbnails by rendering each model's Petri net as a static diagram.

5. **Responsive** — hero section should work on mobile. Stack model cards vertically on narrow screens. Video background can be replaced with a static frame on mobile to save bandwidth.

6. **SEO** — add proper `<meta>` tags to the landing section:
   - `<title>pflow - Visual Editor for Petri Nets</title>`
   - `<meta name="description" content="Browser-based visual editor and ODE simulator for Petri nets. Model state machines, workflows, and token standards.">`
   - Open Graph tags with a screenshot or the flower image as `og:image`

7. **No new dependencies** — vanilla HTML/CSS/JS only. The video and SVGs are the only new assets.

## Model Cards — Candidate Examples

Pull from existing blog posts and built-in models:

| Model | Source | Why |
|-------|--------|-----|
| Coffeeshop | `/posts/coffeeshop-model` | Simple, relatable, good intro |
| Tic-Tac-Toe | `/posts/zk-tic-tac-toe-model` | Game — visually interesting |
| Texas Hold'em | `/posts/texas-holdem-model` | Complex, impressive |
| Sudoku | `/posts/sudoku-petri-net-model` | Puzzle solver — "wow" factor |
| Enzyme Kinetics | `/posts/enzyme-kinetics-model` | Science application |
| Token Language | `/posts/token-language` | Shows the DSL/formal side |

Each card links to the blog post for context AND has a "Open in Editor" button that loads the model directly in pflow.xyz.

## Phased Approach

### Phase 1: Extract and stage assets
- Clone pflow-react-dev, extract video + SVGs
- Convert LogoCard and FlowerBar JSX to standalone SVG files
- Optimize p-flower.mp4 (compress, maybe create WebM version)
- Check GT_America font licensing — fall back to Inter if needed

### Phase 2: Build landing section
- Add `<section id="landing">` to index.html
- Video background hero with title and CTA buttons
- Show/hide toggle between landing and editor
- Test on mobile

### Phase 3: Model cards
- Create SVG thumbnails for 6 example models
- Build card grid with links to editor and blog
- Add ecosystem links footer with flower bar decoration

### Phase 4: SEO and polish
- Meta tags, og:image, structured data
- `prefers-reduced-motion` support
- Performance: lazy-load video, optimize SVGs
- Submit updated URL to Google Search Console

## Questions to Resolve

- **GT_America font** — is there a license for web use? If not, Inter or Space Grotesk are similar alternatives
- **Video size** — p-flower.mp4 may be large. Consider generating a CSS-only animation inspired by the flower, or using a short loop (3-5s) compressed to <1MB
- **Model thumbnails** — render from the editor's SVG export, or hand-craft simplified versions?
- **URL routing** — should `/` show landing and `/editor` show the editor? Or keep it all on `/` with JS toggle?

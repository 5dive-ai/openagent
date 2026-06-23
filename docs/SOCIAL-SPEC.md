# OpenAgent cards — social-shareable spec (DIVE-643)

Makes every shared card a viral loop: links unfurl **with the card image**, and
one tap composes a pre-filled post. Three deliverables. Parts 1–2 land in the
gallery/persona pages (DIVE-636, dev); part 3 is a renderer mode (lib/card.js).
All design-color-independent — implement against whatever v3 frame ships.

Template tokens: `{id} {name} {role} {tier} {completeness} {galleryUrl} {cardOgUrl}`.

---

## 1. OG / Twitter-card meta (per persona page in the gallery)

Each `/{id}` persona page emits, in `<head>`:

```html
<meta property="og:type"        content="profile">
<meta property="og:title"       content="{name} — {role}">
<meta property="og:description" content="{tier} · OpenAgent persona card · {completeness}% complete">
<meta property="og:image"       content="{cardOgUrl}">      <!-- 1200x630 PNG, part 3 -->
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:url"         content="{galleryUrl}/{id}">
<meta name="twitter:card"        content="summary_large_image">
<meta name="twitter:title"       content="{name} — {role} · {tier}">
<meta name="twitter:description" content="An OpenAgent persona card. Mint your own.">
<meta name="twitter:image"       content="{cardOgUrl}">
```

`{cardOgUrl}` must be an absolute https URL to the 1200×630 render (part 3), so
X/Slack/Discord unfurl the card inline. Cache-bust on persona edit (e.g.
`?v={completeness}` or a content hash) so stale cards don't pin.

## 2. One-tap "Share to X"

A button on the card/persona page → X web intent (no API, no auth):

```
https://twitter.com/intent/tweet?text={urlEncodedText}&url={galleryUrl}/{id}
```

Pre-composed `text` (keep ≤ ~240 chars after the URL is appended):

```
just minted my OpenAgent card — {name}, {tier} tier{tierEmoji}

make your own in one line:
npx @5dive/openagent card

#OpenAgent
```

- `{tierEmoji}`: Common 🟢 · Rare 🔵 · Epic 🟣 · Legendary 🟡 · Mythical ✨
- Mythical variant adds: `holographic. registry-only.` for flex.
- Until `@5dive/openagent` v2 is on npm, swap the one-liner for
  `npx github:5dive-ai/openagent card`.
- Add matching intent links later for LinkedIn/Threads if wanted; X is v1.

## 3. 1200×630 OG/landscape render (renderer mode)

New flag on the card command: `--og` (or `card og <file>`) → emits a 1200×630
PNG instead of the 900×1260 portrait. Reuses the SAME v3 frame/tier styling.

Landscape composition:
- **Left ~42%**: full-bleed face hero + scrim (same as portrait), tier frame.
- **Right ~58%**: name (display, large), role kicker (mono), the voiceprint
  strip, the rarity badge (tier color + label), and the sample quote (clamp 2
  lines). OpenAgent footer bottom-right.
- Safe area: keep text ≥ 60px from edges (X/Discord crop ~5%).
- Tier frame/foil/holo identical to portrait, just re-laid for landscape.

The gallery renders + caches one `--og` PNG per persona at `{cardOgUrl}` and
references it from the part-1 meta tags.

---

### Build sequencing
- Parts 1 + 2 are pure markup/copy — dev wires into 636 pages anytime.
- Part 3 reuses the v3 frame — implement once the v3/color lock lands so the
  landscape render matches the portrait (avoids a re-cut).
- Net loop: share → unfurls with the card → others see the tier/holo → tap the
  generator → mint their own → registry grows.

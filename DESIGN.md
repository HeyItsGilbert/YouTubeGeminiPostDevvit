---
name: YouTube + Gemini Post — Preview
description: A calm operator's console for previewing AI-generated Reddit posts before they go live.
colors:
  paper: "#F5F5F0"
  ink: "#141414"
  ink-soft: "#1C1C1C"
  surface: "#FFFFFF"
  success: "#047857"
  success-bg: "#ECFDF5"
  link: "#2563EB"
  danger: "#DC2626"
  danger-bg: "#FEF2F2"
  warning: "#B45309"
  warning-bg: "#FFFBEB"
typography:
  title:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 700
    lineHeight: 1.25
    letterSpacing: "-0.025em"
  eyebrow:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 700
    lineHeight: 1.4
    letterSpacing: "0.1em"
  body:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
  label:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: "normal"
  micro:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "0.625rem"
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: "0.1em"
rounded:
  sm: "4px"
  lg: "8px"
  xl: "12px"
  full: "9999px"
spacing:
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "48px"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.surface}"
    rounded: "{rounded.xl}"
    padding: "12px 16px"
  button-primary-hover:
    backgroundColor: "{colors.ink-soft}"
    textColor: "{colors.surface}"
    rounded: "{rounded.xl}"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.xl}"
    padding: "12px 16px"
  pill-success:
    backgroundColor: "{colors.success-bg}"
    textColor: "{colors.success}"
    rounded: "{rounded.full}"
    padding: "4px 8px"
  pill-danger:
    backgroundColor: "{colors.danger-bg}"
    textColor: "{colors.danger}"
    rounded: "{rounded.full}"
    padding: "4px 8px"
  badge-required:
    backgroundColor: "{colors.success-bg}"
    textColor: "{colors.success}"
    rounded: "{rounded.sm}"
    padding: "2px 6px"
---

# Design System: YouTube + Gemini Post — Preview

## 1. Overview

**Creative North Star: "The Proof Sheet"**

This is the contact sheet you hold up to the light before you commit to a print.
A moderator comes here not to be impressed but to *check their work*: paste a key,
point at a playlist, tune the prompt, and read the exact post the bot will publish.
Everything in the interface serves that single act of verification. The surface is
a calm sheet of warm paper (`#F5F5F0`), the content sits on clean white cards, and
the only saturated colors in the room are the ones that report a fact — green for
"this works," red for "this is broken," amber for "this is taking a while." Nothing
is decorative; every pixel of color is a status.

The personality is **quiet, trustworthy, precise**. The tool should feel like a
well-made instrument: legible at a glance, honest about state, and utterly
unsurprising in how its controls behave. Density is comfortable, not cramped — a
two-column split (configuration left, preview right) lets the operator keep their
inputs and their proof in view at once. Type is a single neutral system sans
across the whole surface; there is no display face, no brand flourish, because the
generated *content* is the star and the chrome must recede behind it.

This system explicitly rejects the marketing-SaaS reflex: no gradient hero, no
oversized clamp display type, no scroll choreography, no glassmorphism-for-show.
It is an operator console, not a pitch. The one place the rules relax is the Reddit
preview pane, which deliberately mimics Reddit's own surface so the proof reads as
true to destination.

**Key Characteristics:**
- Warm-paper canvas, white content surfaces, near-black ink.
- Color is reserved exclusively for status (success / danger / warning / link).
- One neutral system sans, multiple weights — no font pairing.
- Comfortable two-column workspace; chrome recedes, content leads.
- Quiet motion: state feedback and spinners only, never decoration.

## 2. Colors

A near-monochrome paper-and-ink base where every saturated color carries a single, literal status meaning.

### Primary
- **Ink** (`#141414`): The near-black that carries all primary text, the primary
  button fill, icons, and borders (the latter at low opacity). The workhorse;
  effectively the brand's only "color."

### Neutral
- **Paper** (`#F5F5F0`): The warm off-white body canvas. The room the work sits in.
- **Surface** (`#FFFFFF`): Pure white for cards, inputs, the sticky header
  (at 80% with a backdrop blur), and the playlist/preview panels.
- **Ink Soft** (`#1C1C1C`): A hair lighter than Ink, used for the primary button's
  hover state and the Reddit-preview body text where a touch of warmth reads better.

Ink also appears as transparency tiers — `ink/70` and `ink/50` for secondary and
tertiary text, `ink/10` for hairline borders, `ink/5` for the focus ring. **These
opacity tiers are the most accessibility-sensitive part of the palette** (see Do's
and Don'ts).

### Semantic (status only)
- **Success** (`#047857` on `#ECFDF5`): API access confirmed, "REQUIRED" badges,
  copy-succeeded confirmations, the text selection highlight.
- **Link** (`#2563EB`): Outbound links to Google AI Studio / API consoles. The
  only blue in the system.
- **Danger** (`#DC2626` on `#FEF2F2`): API errors, failed access checks, the error
  banner. Always paired with an icon and a fix.
- **Warning** (`#B45309` on `#FFFBEB`): The slow-generation notice and other
  "still working / heads up" states.

### Named Rules
**The Status-Only Color Rule.** Saturated color is forbidden as decoration. If a
green, red, amber, or blue pixel appears on screen, it must report a verifiable
state. Want emphasis without meaning? Reach for weight, size, or an Ink opacity
tier — never a hue.

## 3. Typography

**Display Font:** none — this system has no display face by design.
**Body Font:** UI System Sans (`ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, …`)
**Label/Mono Font:** same family; differentiation is by weight, size, case, and tracking.

**Character:** One neutral, native sans doing every job. The interface inherits the
operating system's own UI face, so it feels local and trustworthy on any platform
and never waits on a web-font load. Hierarchy is built from weight and case, not
from contrasting families.

### Hierarchy
- **Title** (700, 1.125rem/18px, line-height 1.25, tracking -0.025em): The app name
  in the header. The single largest type on the page — deliberately modest.
- **Eyebrow** (700, 0.75rem/12px, uppercase, tracking 0.1em): Section markers like
  "CONFIGURATION." Functional dividers in this dense tool — see the rule below.
- **Body** (400, 0.875rem/14px, line-height 1.5): Input values, help text,
  generated content. Cap prose at 65–75ch in the preview pane.
- **Label** (600, 0.75rem/12px): Field labels, usually at `ink/70`.
- **Micro** (600, 0.625rem/10px, often uppercase + tracked): Status pills, badges,
  inline metadata.

### Named Rules
**The Weight-Not-Face Rule.** Never introduce a second font family. New emphasis
comes from 400 → 600 → 700 and from case, never from a display or serif face.

**The Functional-Eyebrow Exception.** The tiny-uppercase-tracked eyebrow is a
known AI tell and is banned as decorative scaffolding on marketing surfaces. Here
it earns its place *only* as a genuine functional section divider inside a dense
config form (one per real panel). Do not multiply it; if a section doesn't need a
divider, it doesn't get an eyebrow.

## 4. Elevation

This system is **flat by default**. Depth is conveyed by tonal layering — warm
paper behind white surfaces behind low-opacity ink borders — not by shadow. The
single exception is the sticky header, which uses an 80%-opacity white plus a
`backdrop-blur-md` to float content beneath it, and a couple of small functional
shadows on dark pills/chips. There is no ambient drop-shadow vocabulary on cards.

### Shadow Vocabulary
- **Header float** (`background: rgba(255,255,255,0.8)` + `backdrop-filter: blur(12px)`):
  The only persistent elevation; separates the sticky header from scrolling content.
- **Pill lift** (small `box-shadow` on dark status chips, e.g. the model pill):
  Used sparingly to lift a dark element off the dark text around it.

### Named Rules
**The Flat-By-Default Rule.** Surfaces rest flat. If you're reaching for a
drop-shadow on a card, you're solving a contrast or grouping problem the wrong way —
use the paper/white tonal step or a 1px `ink/10` border instead.

## 5. Components

Familiar controls that behave exactly as expected. The whole point is that a mod
never has to *learn* this UI.

### Buttons
- **Shape:** Softly rounded (12px, `rounded-xl`).
- **Primary:** Ink fill (`#141414`), white text, 12px×16px padding. Used for the
  committing actions (Fetch, Generate).
- **Hover / Focus:** Background shifts to Ink Soft (`#1C1C1C`); a visible
  focus-visible ring is required (the current `ink/5` ring is too faint — see Don'ts).
- **Loading:** In-button spinner (`animate-spin`) replacing or preceding the label;
  the button stays the same size to avoid layout shift.

### Inputs / Fields
- **Style:** White background, 1px `ink/10` border, 12px radius, 14px text.
  Some fields carry a leading icon at `opacity-30` (e.g. the playlist field).
- **Focus:** Border holds; a soft `ring` appears. The ring must be strong enough to
  be unmistakable for keyboard users.
- **Placeholder:** Must meet 4.5:1 against white — do not ship the default light gray.

### Status Pills & Badges
- **Success pill:** `#ECFDF5` bg / `#047857` text, fully rounded, icon + label.
- **Danger pill:** `#FEF2F2` bg / `#DC2626` text; when it links to a fix, it's an
  anchor with a hover tint.
- **Required badge:** small `#ECFDF5` / `#047857` chip on required field labels.
- **Rule:** every pill pairs color with an icon and text — never color alone.

### Navigation / Header
- **Style:** Sticky, 64px tall, 80% white + backdrop blur, 1px `ink/10` bottom
  border. App icon + title left; quiet outbound links (Reddit App, GitHub) right at
  `opacity-50`, rising to full on hover.

### Signature Component — The Reddit Preview Pane
The proof itself. A panel that intentionally departs from the console's own styling
to mimic Reddit's rendered post (toggleable raw ↔ Reddit view) so what the mod
approves matches the destination. This is the one place "looks like another product"
is correct, not a smell.

## 6. Do's and Don'ts

### Do:
- **Do** keep color reserved for status — green/red/amber/blue must each report a
  verifiable fact (the Status-Only Color Rule).
- **Do** build hierarchy from weight, size, and case in the single system sans
  (the Weight-Not-Face Rule).
- **Do** verify every muted text tier hits WCAG 2.1 AA: body `ink/70` and `ink/50`
  on `#F5F5F0`/white must clear 4.5:1, large text 3:1, placeholders 4.5:1. Bump
  toward Ink if it's close.
- **Do** give every interactive control a clearly visible `:focus-visible` ring.
- **Do** pair every status color with an icon and text, so meaning survives color blindness and grayscale.
- **Do** provide a `prefers-reduced-motion: reduce` fallback for every `motion/react`
  animation (crossfade or instant); spinners may stay.
- **Do** let the Reddit preview pane look like Reddit — fidelity to destination beats house style there.

### Don't:
- **Don't** add a gradient hero, oversized clamp display type, scroll choreography,
  or the hero-metric template — this is a tool, not a pitch.
- **Don't** introduce a second font family or any serif/display face.
- **Don't** use saturated color decoratively, or rely on color alone to signal state.
- **Don't** ship the faint `ink/5` focus ring as the only focus affordance — it fails keyboard users.
- **Don't** scatter the uppercase-tracked eyebrow as decoration; one functional
  divider per real panel, never more (the Functional-Eyebrow Exception).
- **Don't** add drop-shadows to cards to fake depth — use the paper/white tonal step
  or a 1px `ink/10` border (the Flat-By-Default Rule).
- **Don't** add custom scrollbars, reinvented form controls, glassmorphism-for-show,
  or motion that conveys no state.

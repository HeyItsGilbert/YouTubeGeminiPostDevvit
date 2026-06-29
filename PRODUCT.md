# Product

> Design scope: the only UI surface in this repo is **`preview-site/`** — the
> React + Vite companion web app. The rest of the repo is the headless Devvit
> bot (no frontend). All design guidance below applies to `preview-site/`.

## Register

product

## Users

Subreddit moderators who run (or are evaluating) the YouTube + Gemini Post
Devvit bot. Their context: standing up or tuning the bot and wanting to see
exactly what Gemini will post **before** committing it to a live subreddit.
They bring their own Google API key. Skill level is mixed — some are
comfortable with APIs and prompt-tuning, others are non-technical mods who just
want sane output. The job to be done: paste a key, point at a playlist, edit
the system prompt, fetch a real video, and preview the exact Reddit post (raw
and Reddit-rendered) until they trust it.

## Product Purpose

A pure client-side preview tool that de-risks the bot's configuration. It mirrors
the Devvit app's post-assembly pipeline (`@shared/postUtils`) so the preview
matches production output, lets mods iterate on the system prompt and advanced
settings (prepend/append text, link label, exclusion keywords, model), and
verifies API access without consuming generation quota. No server, no shared
secrets — the user's key lives only in their browser's `localStorage`. Success
is a mod dialing in their prompt and settings with confidence, never having to
trial-and-error in a live subreddit.

## Brand Personality

Calm, dependable, utilitarian. Three words: **quiet, trustworthy, precise.**
The voice is plain and low-ceremony — helpful labels, honest status, no hype.
The emotional goal is "this just works": the interface should disappear into the
task. It is an operator console for a workflow, not a showcase for a product.

## Anti-references

- **Marketing-SaaS landing aesthetic**: gradient hero, oversized clamp display
  type, scroll-driven choreography, the hero-metric template. This is a tool,
  not a pitch.
- **Novelty/over-decorated controls**: custom scrollbars, reinvented form
  controls, gratuitous glassmorphism, decorative motion that conveys no state.
- **Flashy delight at the expense of clarity** — celebration animations or
  personality that slow a mod down or obscure the real output.

## Design Principles

1. **The tool disappears into the task.** Earned familiarity over novelty;
   standard affordances behave the standard way.
2. **Show real output, not a mockup.** The preview must match what the bot
   actually posts — same assembly logic, both raw and Reddit-rendered.
3. **Fail loudly and helpfully.** Surface key/quota/API errors inline with the
   concrete fix (e.g. links to enable the right Google APIs), never a dead end.
4. **Trust through transparency.** Show status the user needs to trust the
   result — API access checks, selected model, generation time — and hide
   nothing material.
5. **Respect bring-your-own-key.** The user's secret never leaves their browser;
   nothing is transmitted or persisted beyond their own `localStorage`.

## Accessibility & Inclusion

Target **WCAG 2.1 AA**. Body text ≥4.5:1 against its background (watch the
`opacity-50`/`opacity-70` muted labels on the `#F5F5F0` paper bg — verify they
clear the bar), large text ≥3:1, placeholders ≥4.5:1. Visible focus states on
every interactive element; fully keyboard-operable forms and controls. Because
the app uses `motion/react`, every animation needs a
`prefers-reduced-motion: reduce` fallback (crossfade or instant). Status must
never be color-only — pair color with an icon/text (the API status pills already
do this).

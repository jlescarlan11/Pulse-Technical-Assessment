# Design Language — Pulse Technical Assessment

**Last Updated:** 2026-06-13

## Overview

**Aesthetic:** Modern, minimal dark theme with vibrant accent colors and smooth motion. Built on Tailwind CSS 4, no custom component library. Emphasis on clarity, responsiveness, and microinteractions.

---

## Color Palette

### Base Colors (Tailwind CSS)

#### Neutrals (Background & Text)
- **Dark background:** `#0a0a0a` (CSS var `--background` in dark mode)
- **Light text:** `#ededed` (CSS var `--foreground` in dark mode)
- **Black:** `#000000` (modals, overlays)
- **Zinc scale:** 50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950 (various opacities)

#### Primary Accent
- **Emerald (green):** Main interactive color
  - **Emerald-400:** Primary button, focus ring color (#10b981)
  - **Emerald-300:** Hover state, lighter variant
  - **Emerald-500:** Alternative emphasis
- **Usage:** Buttons, CTAs, focus rings, active states

#### Danger
- **Red-500:** Error messages, decline actions
- **Red-400:** Hover state for danger buttons

#### Semantic
- **White:** Text, borders, focus indicators (rgba(255, 255, 255, 0.9))
- **Transparent:** Overlays, gradients (rgba(255, 255, 255, 0.4))

### Color Usage

| Element | Color | Notes |
|---------|-------|-------|
| Page background | `#0a0a0a` | Dark mode default |
| Primary text | `#ededed` | High contrast on dark bg |
| Buttons (primary) | Emerald-400 | CTAs, accept actions |
| Buttons (danger) | Red-500 | Decline, end call |
| Buttons (hover) | Emerald-300 / Red-400 | Interactive feedback |
| Focus ring | Emerald-400 2px | Accessibility |
| Modal backdrop | `rgba(0, 0, 0, 0.6)` | Semi-transparent |
| Peer dots | Hash-based HSL | Dynamic per user (hsl(hash % 360, 70%, 60%)) |
| Pulse ring (dot animation) | `rgba(255, 255, 255, 0.4)` | Fading white glow |
| Glow pulse (active video) | `rgba(16, 185, 129, 0.5–0.8)` | Emerald glow |

### Light Mode (Prefers Light)

```css
:root {
  --background: #ffffff;    /* White bg */
  --foreground: #171717;    /* Dark text */
}
```

(Currently unused; app is dark-first, but CSS supports both.)

---

## Typography

### Font Family
- **Sans-serif primary:** Vercel Geist Sans (via Next.js defaults)
- **Monospace:** Vercel Geist Mono (for code, if needed)
- **Fallback:** Arial, Helvetica, sans-serif (for rapid load)

### Type Scale (Tailwind Defaults)

| Use Case | Class | Size | Weight |
|----------|-------|------|--------|
| Large heading | `text-3xl` | 30px | 700 |
| Section heading | `text-2xl` | 24px | 700 |
| Subheading | `text-xl` | 20px | 600 |
| Body text | `text-base` | 16px | 400 |
| Small text | `text-sm` | 14px | 400 |
| Tiny text | `text-xs` | 12px | 400 |
| Button text | `text-base` | 16px | 600 |
| Label | `text-sm` | 14px | 600 |

### Font Weights

- **400 (normal):** Body text, descriptions
- **600 (semibold):** Labels, buttons, subheadings
- **700 (bold):** Headings, emphasis

### Line Height

- Default: 1.5 (comfortable reading)
- Headings: 1.2 (tight)
- Buttons: 1 (single line)

---

## Spacing Scale

### Gap & Padding (Tailwind Defaults)

| Size | Pixels | Usage |
|------|--------|-------|
| `p-1` | 4px | Tight spacing |
| `p-2` | 8px | Component padding |
| `p-3` | 12px | Button/input padding |
| `p-4` | 16px | Section padding |
| `p-6` | 24px | Container padding |
| `p-8` | 32px | Large sections |

### Gaps (Between Items)

- **`gap-2`** (8px): Tight lists
- **`gap-3`** (12px): Button groups, form fields
- **`gap-4`** (16px): Main sections
- **`gap-6`** (24px): Major layout dividers

### Margins

- **`m-0`:** Remove default
- **`mb-4`:** Bottom margin between sections (16px)
- **`mt-2`:** Top margin for spacing

### Border Radius

- **`rounded-lg`** (8px): Buttons, modals, cards
- **`rounded-full`** (9999px): Circles (dots, badges)
- **No rounded:** Maps, large containers

---

## Motion & Animation

### Animation Library (in globals.css)

#### Keyframes (10+)

1. **`fade-in`** (0.3s)
   - Opacity: 0 → 1
   - Use: Page loads, messages arriving

2. **`fade-in-up`** (0.4s)
   - Opacity: 0 → 1, Transform: translateY(12px) → 0
   - Use: Modals, notifications entering from bottom

3. **`fade-in-down`** (0.4s)
   - Opacity: 0 → 1, Transform: translateY(-12px) → 0
   - Use: Dropdowns, notifications entering from top

4. **`scale-in`** (0.3s)
   - Opacity: 0 → 1, Transform: scale(0.95) → 1
   - Use: Button presses, modal open

5. **`slide-in-right`** (0.3s)
   - Opacity: 0 → 1, Transform: translateX(20px) → 0
   - Use: Chat panel entrance

6. **`slide-out-right`** (0.3s, ease-in)
   - Opacity: 1 → 0, Transform: translateX(0) → translateX(20px)
   - Use: Chat panel exit

7. **`pulse-ring`** (2s infinite)
   - Box-shadow: 0 0 0 rgba(255, 255, 255, 0.4) → 0 0 0 8px rgba(255, 255, 255, 0)
   - Use: Online dots, pulsing effect

8. **`glow-pulse`** (2s infinite)
   - Box-shadow: 0 0 20px → 0 0 30px (emerald glow)
   - Use: Active video connections, emphasis

9. **`spin-smooth`** (1s infinite linear)
   - Rotate: 0deg → 360deg
   - Use: Loading spinners

10. **`button-press`** (0.2s)
    - Scale: 1 → 0.95 → 1
    - Use: Tactile feedback on button click

#### Easing Functions

- **`ease-out`:** Default, for entrances (cubic-bezier(0.5, 1, 0.89, 1))
- **`ease-in`:** For exits
- **`cubic-bezier(0.34, 1.56, 0.64, 1)`:** Spring-like bounce on interactive elements

#### Stagger Delays

- `.animate-stagger-1` through `.animate-stagger-5`
- Delays: 0s, 0.05s, 0.1s, 0.15s, 0.2s
- Use: Cascading animations for lists

#### Timing

- **Fast:** 0.2–0.3s (micro-interactions, button presses)
- **Normal:** 0.3–0.4s (page transitions, modals)
- **Slow:** 2s (infinite loops, ambient pulses)

#### Mobile Optimizations

- **Faster animations** on mobile: All 0.25s (snappier feel on slower devices)
- **Reduced stagger delays** on mobile: 0s, 0.03s, 0.06s, 0.09s, 0.12s

### Transition Defaults

All interactive elements have smooth transitions:
```css
button, input, a {
  transition-property: all;
  transition-timing-function: cubic-bezier(0.4, 0, 0.2, 1);
  transition-duration: 150ms;
}
```

**Effect:** Color, background, shadow, transform changes are smooth (not instant).

---

## Component Aesthetics

### Buttons

**Primary (Emerald):**
- Background: Emerald-400
- Text: Dark text (contrast)
- Hover: Emerald-300 (lighter)
- Focus: 2px Emerald-400 outline, 2px offset
- Padding: `px-4 py-2`
- Border radius: `rounded-lg`
- Animation on click: `button-press` (scale 0.95)

**Danger (Red):**
- Background: Red-500
- Hover: Red-400
- Same padding, radius, focus, animation

**Secondary (Ghost):**
- Background: Transparent
- Border: 1px white
- Hover: White text, background rgba(255, 255, 255, 0.1)

### Modals & Overlays

**Backdrop:**
- Background: `rgba(0, 0, 0, 0.6)` (dark, semi-transparent)
- Animation: `fade-in` (0.2s)

**Content:**
- Background: `#0a0a0a` border `1px solid rgba(255, 255, 255, 0.1)`
- Border radius: `rounded-lg`
- Padding: `p-6`
- Animation: `scale-in` (0.3s, cubic-bezier spring)
- Shadow: `shadow-2xl` (depth, Tailwind default)

### Inputs & Textareas

- Border: `1px solid #333` (dark zinc)
- Padding: `px-3 py-2`
- Border radius: `rounded-md`
- Focus: `outline-emerald-400 outline-offset-2`
- Transition: All (150ms)
- No placeholder color override (system default)

### Chat Bubbles

- **Own messages:** Right-aligned, emerald-400 background, white text
- **Peer messages:** Left-aligned, zinc-800 background, light text
- Padding: `px-4 py-2`
- Border radius: `rounded-lg`
- Animation: `fade-in-up` (0.3s) when arriving

### Peer Dots (On Map)

- **Size:** 14px × 14px
- **Border:** 2px white
- **Border radius:** Full circle (`rounded-full`)
- **Color:** Hash-based HSL (per user, consistent)
- **Cursor:** Pointer (clickable)
- **Animation:** `pulse-ring` (2s infinite, white glow fading)
- **Hover:** `scale(1.3)` (grow on hover, 0.15s transition)
- **Click:** `button-press` animation (tactile feedback)

### "You Are Here" Marker

- **Emoji:** 📍 (pin icon)
- **Size:** 18px
- **Label:** "Me" text above pin
  - Font: Tiny (10px), bold
  - Background: `rgba(0, 0, 0, 0.6)` (dark)
  - Padding: `px-1` rounded full
- **Filter:** `drop-shadow(0 1px 2px rgba(0, 0, 0, 0.6))`
- **Animation:** `fade-in` (0.5s on load)

### Loading States

- **Spinner:** SVG or CSS `animate-spin-smooth` (1s infinite)
- **Color:** Emerald-400
- **Size:** 24px × 24px
- **Overlay:** Semi-transparent backdrop (prevents interaction)

### Notice / Toast

- **Style:** `bg-zinc-900 border-l-4 border-emerald-400`
- **Padding:** `px-4 py-3`
- **Text:** `text-sm text-gray-100`
- **Animation in:** `fade-in-down` (0.3s from top)
- **Animation out:** Reverse of fade-in-down (0.2s)
- **Duration:** Auto-dismiss after 3.5 seconds

---

## Layout

### Main Page Structure

```
[Header: Mapbox Map — Full Width]
│
├─ [Left/Top: Map Container]
│  ├─ Mapbox GL (responsive, no padding)
│  ├─ Peer dots (interactive)
│  └─ You marker (bottom-left anchor)
│
└─ [Right/Bottom: Chat/Video Panel]
   ├─ ConnectionPrompt (modal overlay)
   ├─ ChatPanel (when connected)
   │  ├─ Message history (scrollable)
   │  ├─ Video button
   │  └─ Input field + send button
   └─ VideoPanel (when video active)
      ├─ Remote video (full-screen)
      ├─ Local video (PiP, corner)
      ├─ Mute/camera controls
      └─ End call button
```

### Responsive Design

#### Desktop (> 768px)
- Map: Left side, 70% width
- Chat/Video: Right sidebar, 30% width, fixed height
- Modals: Center screen, max-width 400px

#### Mobile/Tablet (< 768px)
- Map: Full screen
- Chat/Video: Slide-up from bottom, full width
- Modals: Full-screen or bottom-sheet style
- Animations: Faster (0.25s instead of 0.3–0.4s)
- Font sizes: Slightly reduced for small screens

#### Breakpoints (Tailwind)
- `sm` (640px)
- `md` (768px) — Main breakpoint for this app
- `lg` (1024px)
- `xl` (1280px)

---

## Accessibility

### Color Contrast

- **Text on background:** White (#ededed) on black (#0a0a0a) = 15:1 (AAA)
- **Buttons:** Emerald-400 on white = 5.5:1 (AA, acceptable for large text)
- **Focus ring:** Emerald-400 outline, high contrast

### Focus States

- **Visible focus ring:** 2px solid emerald-400, 2px offset
- **Applied to:** buttons, inputs, links
- **No hidden focus:** Enforced via CSS (no `outline: none` without replacement)

### Keyboard Navigation

- **Tab order:** Native (semantic HTML, no custom tabindex)
- **Enter key:** Activates buttons, submits forms
- **Escape key:** Closes modals (client-side handler in page.tsx)

### Motion

- **Respects prefers-reduced-motion:** Not explicitly implemented (should add for accessibility)
- **Animations can be disabled:** User can turn off in browser settings

### Semantic HTML

- `<button>` for buttons (not `<div>` with click handlers)
- `<input>` for text fields (not custom)
- `<label>` for form labels (if present)
- ARIA roles not used (keep simple for this app)

---

## Visual References & Inspiration

**Aesthetic inspirations:**
- **Vercel:** Minimal dark theme, emerald accents, fast animations
- **Figma:** Interactive, responsive, smooth transitions
- **Discord:** Chat bubble styling, online status dots

**Color mood:**
- **Dark & modern:** Tech-forward, night-mode friendly
- **Emerald green:** Energetic, fresh, trustworthy
- **Minimal:** No gradients, shadows, or decorative elements beyond functional animations

---

## Summary

| Aspect | Details |
|--------|---------|
| **Theme** | Dark-first (light mode supported via CSS vars) |
| **Primary color** | Emerald-400 (#10b981) |
| **Typography** | Geist Sans, no custom fonts |
| **Type scale** | Tailwind defaults (xs–3xl) |
| **Spacing** | Tailwind grid (4px base, 8px increments) |
| **Border radius** | Rounded-lg (8px) for components, full for circles |
| **Animations** | 10+ keyframes, 0.2–2s range, spring easing |
| **Motion tone** | Smooth, purposeful, not excessive |
| **Accessibility** | High contrast (15:1), visible focus rings, keyboard support |
| **Layout** | Responsive (desktop sidebar + mobile bottom-sheet) |
| **Components** | No library; utility-first Tailwind + custom CSS |
| **Dark mode** | CSS vars, prefers-color-scheme media query |

# Agent Reliability UI Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Apply Profy-inspired warm workbench styling to the web app while preserving current routes and data behavior.

**Architecture:** Keep existing page data fetching and components. Extend the global token layer, add a responsive app shell in the root layout, and refine the tasks/evaluations pages with shared visual classes and compact stat summaries.

**Tech Stack:** Next.js 16, React 19, Tailwind CSS v4, Geist fonts.

---

### Task 1: Global design tokens

**Files:** `apps/web/src/app/globals.css`

- [ ] Replace the minimal root variables with warm background, card, border, primary, status, radius, shadow, and motion tokens.
- [ ] Add base body typography, selection, focus-visible, reduced-motion, and table utility styles.
- [ ] Keep Tailwind theme variables mapped to the existing names.

### Task 2: Responsive application shell

**Files:** `apps/web/src/app/layout.tsx`

- [ ] Replace the single top header with a responsive sidebar containing brand, route links, and environment metadata.
- [ ] Add mobile top bar and retain `main` max-width/content padding.
- [ ] Use `usePathname` in a small client navigation component if active link state requires client rendering.

### Task 3: Shared status visuals

**Files:** `apps/web/src/components/status-badge.tsx`, `apps/web/src/components/error-card.tsx`

- [ ] Update status and agent badges to use token-backed colors, dot indicators, and consistent typography.
- [ ] Restyle error card with icon-like marker, action button, and warm border treatment.

### Task 4: Tasks page hierarchy

**Files:** `apps/web/src/app/tasks/page.tsx`

- [ ] Add eyebrow, title, description, and summary stat cards derived from loaded task data.
- [ ] Restyle create button, empty state, loading state, dialog, table, and links using the new shell tokens.
- [ ] Preserve all current API calls and mutation behavior.

### Task 5: Evaluations page hierarchy

**Files:** `apps/web/src/app/evaluations/page.tsx`

- [ ] Add eyebrow/title and summary cards derived from evaluation data.
- [ ] Restyle table, selected row, detail panel, metric cells, and empty/loading states.
- [ ] Preserve selection and detail fetching behavior.

### Task 6: Verification

- [ ] Run `npm run lint` in `apps/web`.
- [ ] Run `npm run build` in `apps/web`.
- [ ] Review desktop and narrow viewport behavior in the browser.

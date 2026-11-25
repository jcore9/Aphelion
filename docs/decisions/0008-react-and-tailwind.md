# 0008. The web client uses React and Tailwind

- Status: Accepted
- Date: 2026-11-21
- Decided by: project owner
- Amends: the plan's Open decisions ("SolidJS + Tailwind") and M5-01

## Context

The plan recommended SolidJS with Tailwind for the web client, which is also the GUI the desktop app wraps. No UI code exists yet; the first UI arrives in M5 (M1's test client is a command-line tool). UI plugins run in sandboxed iframes and talk to the app through a message API, so the app's framework doesn't constrain plugin authors.

What mattered: streaming chat performance, a graph library for the bot map, theming through design tokens, contributor familiarity, a path to the M9 native app, and how reliably coding tools write the framework, since they write most of the code.

| Option | For | Against |
| --- | --- | --- |
| SolidJS | Updates only what changed, so it's the fastest for streaming text and live status; tiny bundle | Small ecosystem and only a community graph library; React habits silently break its reactivity; 2.0 migration ahead |
| React 19 | Largest ecosystem; React Flow for the bot map; coding tools write it best; React Native path for M9 | Larger bundle; streaming needs care to avoid excess re-renders |
| Svelte 5 | Small, fast compiled output; Svelte Flow for the map; good animation tools | Svelte 5 changed reactivity, so much of the example code coding tools learned from is outdated |
| Vue 3 | Mature; Vue Flow; gentle learning curve | Less common in this space; a second syntax in single-file components |
| Lit | Standards-based, framework-neutral | Weak for a whole app; better for plugin slots than for the app |

## Decision

React with Tailwind.

- Protocol handling, client state and data logic live in plain TypeScript outside components, so components stay thin.
- Components style themselves only through design tokens exposed as CSS variables, which Tailwind maps to utilities. The token lint rule from M5-02 enforces it.
- Streaming chat renders through a store that batches updates, so a long stream doesn't re-render the whole conversation.

## Consequences

- Changing the framework is cheap until M5 and gets more expensive as the UI grows. Keeping logic outside components and plugins behind the iframe message API limits that cost.
- Themes and UI plugins don't depend on React or Tailwind. Themes are tokens and scoped CSS; plugins are iframes.
- M5-01's acceptance criteria change from SolidJS to React. M5-05 can use React Flow for the bot map, subject to its own review.
- When M0-16 moves the plan into the docs site, it updates the Open decisions row.

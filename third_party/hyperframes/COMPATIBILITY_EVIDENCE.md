# HyperFrames 0.7.104 Compatibility Evidence

This is the reviewed evidence for the Phase 3F.0 authority amendment. The
upstream checkout was pinned to commit
`c96b30c7174984e684620556ce871a285381ec60` (`v0.7.104`) and was not added to
Oloka's dependency graph.

| Gate                           | Upstream evidence                                                                                                                                                                                                | Result                                                        |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Unique-origin sandbox          | `packages/player/src/iframe-dom.ts:48` calls `iframe.sandbox.add("allow-scripts", "allow-same-origin")`; `packages/core/src/generators/hyperframes.ts:552` emits the same pair.                                  | Incompatible with Oloka's required `sandbox="allow-scripts"`. |
| No external runtime fetch      | `packages/player/src/composition-probe.ts:28` returns `https://cdn.jsdelivr.net/npm/@hyperframes/core@${version}/dist/hyperframe.runtime.iife.js`; `packages/player/tsup.config.ts:18` embeds the same fallback. | Incompatible with fail-closed/no-CDN execution.               |
| No Studio server in production | Published `@hyperframes/core@0.7.104/package.json:223` declares `"@hyperframes/studio-server": "0.7.104"`.                                                                                                       | Incompatible with Oloka's production dependency rule.         |

The decision is to vendor only the exact runtime IIFE required for deterministic
playback, keep its bytes unchanged, and use an explicit Oloka host/wrapper. No
official player/core package, Studio, CLI server, or node_modules patch is used.

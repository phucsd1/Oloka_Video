# Out of Scope for MVP

The following are explicitly excluded and must not appear as supported MVP UI, API, domain state, provider fallback, or deployment path:

## Identity and collaboration

- Password authentication, registration/reset, GitHub OAuth, magic links, anonymous product access.
- Workspace, Organization, Team Workspace, aliases, hidden/default Projects.
- Multi-user collaboration, sharing, organization roles, advanced undo/redo.

## Editing and AI

- Full visual Studio, direct HTML/CSS editing, arbitrary JavaScript/code execution, free-form DOM mutation.
- AI multi-turn editing and arbitrary render-only chat flows.
- URL-to-video, scraping, website screenshot/browser capture, remote arbitrary download, web asset search.

## Assets and audio

- Global/shared Asset or BGM library.
- Semantic/embedding/similar search, AI enrichment, OCR/transcript advanced search.
- Exact duplicate cleanup, semantic duplicate detection, advanced collection taxonomy.
- Smart BGM, AI music selection, mood classification and automatic licensing lookup.

## Quality, distribution and deployment

- Mandatory visual AI review or human approval.
- Social publishing, TikTok/YouTube/Facebook connections, `posted`, Publication/PublishJob/PlatformConnection.
- Cloudflare frontend/backend, D1, R2, alternate topology, dual deployment or dual-write migration.
- Local render as a product option or automatic hosted fallback.

Future adoption requires a new product decision and ADR; it cannot be enabled only by exposing legacy/reference behavior.

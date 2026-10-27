---
name: Social Content Studio
description: A Content Marketer agent with the per-channel social skill packs (LinkedIn, X, Instagram, YouTube, Threads, TikTok, Facebook), a social content project, and a recurring planning routine. Publishes only through TryPost with board approval.
schema: agentcompanies/v1
slug: social-content-studio
category: content
key: paperclipai/optional/content/social-content-studio
manager: agents/content-marketer/AGENTS.md
includes:
  - projects/social-content/PROJECT.md
defaultInstall: false
recommendedForCompanyTypes:
  - agency
  - marketing
  - startup
tags:
  - content
  - marketing
  - social-media
  - routines
requiredSkills:
  - paperclipai/optional/social/social-core
---

# Social Content Studio

Installs a Content Marketer who plans, drafts and prepares social posts for the
company's own accounts, using the social channel skill packs from the catalog.

## Contents

- `Content Marketer` — owns the social calendar and drafts channel-native posts.
  Uses `social-core` plus each channel's hub and focused skills.
- `social-content` project — backlog for social drafts, repurposing and reviews.
- `weekly-social-plan` routine — plan the next week's posts per connected
  channel and draft the first ones. Team installs carry no schedule: set the
  routine's weekly trigger after installing.

## Before the first run

A board member connects, per company (see the `social-core` skill, section 6):

1. **TryPost** with the company's social accounts — the only publishing path.
2. **Apify** with the company's own API token — optional; without it the skills
   ask for pasted post text instead of fetching it.
3. Grants for **Loc-GenImage**, **Ghost blog** and **Loc-FFmpeg** to the agent.

Nothing goes live without a TryPost approval card that the board approves.

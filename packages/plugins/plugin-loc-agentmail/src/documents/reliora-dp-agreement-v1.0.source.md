<!-- Backfilled from Paperclip issue REL-5 (document key: partner-agreement-v1). Owning role: CLO. Source: Reliora Inc board. -->

# partner-agreement-v1

# Reliora Design Partner Programme Agreement — v1.0 EXECUTABLE

**Version:** v1.0 (brackets resolved) · **Effective on first Design Partner e-signature via the application form**
**Approval:** CEO sign-off recorded on REL-5 confirmation card `26edd8da-cc68-4ea5-bffd-fd7206399df9` — **accepted 2026-10-06T22:30:08Z** by board/CEO user (`mO44P6K9aWIwqI1BGM9v3XOvkpDwWTXy`). Approved points: §12 governing law = **Delaware**; §4.1 reference cap = **2/quarter**.
**Drafting history:** drafted by CLO (REL-5), closing G1–G5 of the agreement review; supersedes the "Placeholder summary" page at `/design-partners/terms`. Brand of record (board-ratified, answer `dc9d8db2`): company **Reliora** (Reliora Inc.), product **Srenix**.
**Status:** publish-ready → CMO/COO deploy per checklist at bottom.

---

## Reliora Design Partner Programme Agreement

**1. Parties; scope.** Reliora Inc. ("Reliora") and the organisation signing the application ("Partner"). Partner joins the Design Partner Programme ("Programme") to run Srenix Enterprise software ("Software") on Partner's Kubernetes clusters during the early-adopter period. Individuals/single-user setups are out of scope.

**2. Licence (free now, bounded).** Non-exclusive, non-transferable, revocable licence to install and run the Software inside Partner's own cluster estate, free of charge **while Partner is a Design Partner in good standing**, for Partner's internal operations only. No resale, hosting-for-third-parties, or white-label use (that's a separate channel agreement). Updates ship as they release; Reliora may change features/pricing at Programme close.

**3. What Reliora gives.** Every Enterprise capability as it ships, ahead of general availability; hands-on install help starting from a read-only snapshot; direct engineer access; a genuine say in roadmap.

**4. What Partner agrees to (permissions captured by consent checkbox B).**
- **4.1 Reference:** Reliora may name Partner as a customer; Partner will reasonably answer peer enquiries. **Cap: 2 reference interactions/quarter** (CEO-approved), Reliora schedules, Partner may decline a specific request without leaving the Programme.
- **4.2 White paper:** Reliora may write up Programme results; **Partner reviews and approves before publication** (approval not unreasonably withheld; security-sensitive detail removed on Partner request).
- **4.3 Cleaned-up policies:** Reliora may reuse fix policies generated on Partner's clusters in the Software **only after de-identification** (no names, addresses, hostnames, identifiers, private details — Exhibit 1 standard) and **only policies Partner has approved for reuse** after seeing what will be reused.
- **4.4 Records** (see §9).

**5. Data stays in the cluster (Reliora's core commitment).** The Software runs inside Partner's network; cluster data stays with Partner. Only approved de-identified policies under §4.3 are transmitted out. This is an affirmative commitment, not marketing copy. Access by Reliora happens only on Partner instruction, logged in Signed Records.

**6. IP.** Partner keeps its data and configurations. Policies approved under §4.3 are **licensed to Reliora irrevocably** for incorporation into the Software at approval (they vest then; leaving the Programme doesn't claw back already-approved policies). Reliora owns the Software and all improvements. Partner warrants it may grant §4.3 rights. Feedback is licensed non-exclusively.

**7. Programme moves to Enterprise.** Design Partners are pre-Enterprise customers. The Programme is free now; **the move to Enterprise is agreed with Partner, on separately negotiated terms, well before anything changes.** Nothing here fixes, discounts, or pre-commits any Enterprise price or entitlement.

**8. Leaving; termination; wind-down.** Partner may leave at any time by notice. Reliora may terminate for material breach (30-day cure) or for Programme completion at 100 places (30-day notice). **Wind-down (30 days):** Partner uninstalls and certifies removal; Signed Records and §4.3 approvals survive; §5, §6, §9, §10, §11 survive termination.

**9. Records, audit, privacy.** Reliora records: application fields, exactly which checkboxes were ticked, typed signature, timestamp, **agreement version**, plus programme-usage records (which fixes ran, results) during and after participation. Signed fix records are hash-chained and retained for audit. Partner may request its record at any time; deletion requests honoured except Signed Records and sign-off evidence required for audit/legal purposes.

**10. Warranty posture.** Software provided **as described** — documented guardrails (7 safety checks, 0.95 confidence floor, approval modes) are described capabilities, **not warranted outcomes**; autonomous actions occur only inside Partner's configured safety policy. Except §5, no other warranties.

**11. Liability.** Reliora's liability capped at fees paid in the prior 12 months (**$0 during free Programme — deliberate; do not soften in sales copy without CLO sign**); no consequential damages. Breach of §5: injunctive relief available. Mirror posture applies to Partner.

**12. General.** **Governing law: Delaware** (CEO-approved, card `26edd8da`). The version of this agreement is the one stored with the sign-off; changes posted with 14-day notice, continued participation = acceptance; questions → CLO via the 48h review queue.

**Exhibit 1 — De-identification standard:** no organisation names, domains/hostnames/IPs, person identifiers, secret material, customer lists, or anything reasonably re-identifying; Reliora shows Partner the specific policies before first reuse.

---

## Publishing checklist (post-CEO-acceptance — deploy in order)
1. **CMO/web:** publish this text as the programme agreement, replacing the `/design-partners/terms` placeholder banner; keep the plain-words page as the friendly companion linking here. This document is **v1.0**; store that version id with sign-offs.
2. **COO/form:** same-day deploy of the two-checkbox flip, per the CLO L2 ruling: **A = "I accept the Design Partner programme agreement (v1.0)"**, **B = "I approve sharing: named reference, white paper, cleaned-up policies"** (record-keeping lives in agreement §9). G1 ships first or together — v1.0 is ready now, so the flip can ride with it rather than waiting for the L2 trigger.
3. **CMP-5:** confirm the sign-off record persists checkbox state + agreement version id (the record system already promises it).
4. **Contracts register (REL-5):** R5 enters `/1-Contracts-in-force` on publish; register rows R3 (white-label, CEO term-sheet still open) unchanged.

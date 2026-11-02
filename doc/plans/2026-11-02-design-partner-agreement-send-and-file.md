# Design Partner agreement: send as PDF, receive the signed copy, file it

Date: 2026-11-02. Owner: board (Salil). Builds on REL-3323 and REL-3325 (pipeline), REL-3326 (v1.0 text), REL-3332 (Drive folder).

## The pipeline the board defined

1. A Design Partner application reaches `info@reliora.ai` (reliora-website forms API notice, "Contract fields" block first).
2. The COO's triage runs the automated fit check on the form answers. There is no call before the agreement.
3. **One email from info@** goes to the email address on the form, with the **v1.0 agreement as a PDF attachment** that the partner signs. The board approves the exact email first (`outbound-email-approval`).
4. The partner signs and replies to info@ with the signed PDF.
5. The COO reviews the signed copy and files it as an executed document in Google Drive, in an `executed` folder separate from the sent copies. The tracker row on REL-2995 moves to stage `agreement`.

## Why it does not work today

| Step | Gap |
|---|---|
| 3 | `paperclip.loc-agentmail:send` takes text and HTML only. No attachments. |
| 4 | `read_message` returns the text body only. Attachments are invisible. |
| 3, 5 | Drive upload (`gw_create_file`) takes the file as base64 in the tool call. An agent cannot relay 100 KB of base64 between tools reliably, and must not retype legal text. |
| 3 | Loc-PDF (`pdf_generate_pdf`) is not usable: its `url` mode returns an address nothing serves, it substitutes applicant values into HTML without escaping (markup injection into a legal document), and the agent would have to pass the whole agreement text in every call. |

## Design rule

File bytes never pass through the model, and the model never retypes the agreement. The agent passes **references and fields**; the connector holds the text, renders, fetches and uploads server-side.

## Change: Loc-AgentMail connector (`packages/plugins/plugin-loc-agentmail`)

1. **Document templates, in source.** `src/documents/` holds the agreement body as committed text with its version (`reliora-dp-agreement`, `v1.0`). A test pins its sha256, so any edit fails the build until the CLO-approved text and the pin change together. Each template lists the mailbox accounts allowed to send it (`reliora-info`).
2. **PDF renderer, no dependencies.** A small deterministic PDF writer (standard Helvetica, WinAnsi, wrapping, page breaks, page numbers). The PDF has the agreement text, a "Partner details" page filled from the fields (organisation legal name, signatory name, job title, email, application reference, application sign-off time, agreement version), and a partner signature block (signature, name, title, date). Fields are forced to one line, length-capped, and rejected if a character cannot be printed, so nothing is silently dropped. Same template and fields give the same bytes, so the sha256 identifies the document.
3. **`send` attachments.** `attachments: [{ template, fields }]` (at most 3). Rendered at send time, sent as `multipart/mixed`, PDF only, 5 MB cap. The result returns each attachment's filename, sha256 and page count, and the activity log records them.
4. **`read_message` attachments.** The result lists each attachment: index, filename, content type, size, sha256. Bytes are not returned.
5. **`file_to_drive`** (new tool). Source is either an inbound attachment `{ account, uid, attachmentIndex }` (re-fetched from IMAP, the mailbox stays the source of truth) or a rendered document `{ template, fields }` (the sent copy, byte-identical to what was sent). The connector uploads it through the Google Workspace MCP server (`gw_create_file`, server-side base64) to a **folder allow-listed in config** with a name the agent gives (sanitised, `.pdf`). Returns the Drive file id, link and sha256. An agent cannot file to any other folder.
6. **Config.** `drive: { mcpUrl, apiKeyRef, tenantId, account, folders: { key: folderId } }`. Secrets stay secret refs resolved at call time.

Governance: `send` already goes through `outbound-email-approval`. `file_to_drive` is a write; it is allowed for the COO under the C-level "write to Drive" rule.

## Change: COO instructions (Reliora)

- The fit check is the automated criteria check on the form answers. On pass, draft one email to the form's email address with the agreement attached (`send` with the template and the Contract fields), through `outbound-email-approval`. Ask for the legal name in the same email if the form gave something that is not one (for example "test"), and send nothing until it is known: the agreement names the Partner.
- After sending, `file_to_drive` the sent copy to `sent` as `<organisation>-dp-agreement-v1.0-sent-<YYYY-MM-DD>.pdf`; set `contract_sent_at` on the tracker row.
- On a reply with a PDF: check the sender is the signatory email, the reference matches, and the attachment is a PDF. The COO cannot verify a handwritten signature; it raises a board confirmation card with the Drive link. On yes, `file_to_drive` to `executed` as `<organisation>-dp-agreement-signed-<YYYY-MM-DD>.pdf` and move the row to `agreement`.
- Drive folders under AI Team > COO > `design-partner-contracts`: `sent` and `executed`. Folder ids go in the connector config.

## Not in scope, flagged

- Reliora countersignature: v1.0 says it is effective on the partner's sign-off; the PDF has no Reliora signature block. Board decision if one is wanted.
- The website sign-off still records terms `2026-09-v4`, not agreement v1.0 (CLO publishing checklist).

## Delivery

Paperclip PR into `main`, tests at the tool level with real bytes (render, parse a real multipart reply with a PDF, upload call shape against a stub MCP server). Production image build on gpu, helm upgrade by the owner. Live proof: a real send to a test address, a real signed reply, the file in `executed`.

## Review record (Fable 5.1 plan safety round, 2026-11-02) and dispositions

| # | Finding | Disposition |
|---|---|---|
| B1 | `file_to_drive` has no write verb, so the gateway classifies it as read. | **Fixed in design:** the tool is `create_drive_file` (write). |
| B2 | `to`/`cc` are free; a long body pushes the recipient out of the approval summary. | **Fixed in design:** with an agreement attached, `to` must be exactly the template's recipient field (the signatory email), one address, and `cc` is refused. |
| B3 | Re-fetch by uid and re-render have no identity check; the sent Message-ID is dropped. | **Fixed in design:** the sent copy is filed inside the same `send` call (`fileSentCopyTo`), so no re-render. `create_drive_file` from a message needs the attachment's `sha256` from `read_message` and refuses on mismatch. `send` returns and logs the RFC Message-ID and each attachment's sha256; the COO matches a reply on In-Reply-To/References, not on From alone. |
| B4 | A hand-written PDF writer repeats the escaping bug class; no widths; no round trip. | **Fixed in design:** use `pdf-lib` with an embedded Unicode font (Noto Sans, OFL), which escapes strings and measures text. A test extracts the text back from the rendered PDF and compares it with the template verbatim. Characters the font cannot draw are refused with a clear error. |
| M1 | The folder allow-list narrows the new tool only; the COO's Workspace connection can already write any folder. Drive is the owner's bionicaisolutions.com account. | **Accepted, claim rescoped.** Owner decision whether executed Reliora agreements need a Reliora-domain account. |
| M2 | Card "with the Drive link" before the file exists; `success:false` returned as HTTP 200; failures not visible. | **Fixed in design:** reply PDFs are filed first to `received` (no gate), and filing to `executed` is a separate call gated by a gateway `require_approval` policy, so the board's approval card is the review. `success:false` is a failure. Every send and filing, success or failure, writes an activity entry with template, version, sha256, Message-ID and Drive id. |
| Dissent | "outbound-email-approval" is a convention, not a gateway policy (verified: no require_approval on `paperclip.loc-agentmail:send` in production). | **Fixed in design:** add gateway policies: `require_approval` on `send` when `attachments` exists, and on `create_drive_file` when the folder is `executed`. |
| Dissent | Any Reliora agent may use reliora-info. | **Accepted:** every agreement send needs board approval by policy. |
| L1 | Attachments must be handled as bytes; list fetches pull whole messages. | **Fixed for attachments** (byte-level parsing). Header-only listing **scheduled**, not in this change. |

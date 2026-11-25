# 0006 — Index the identifiers of the whole session beside its opening text

Status: Proposed, 2026-11-25, for 0.1.0-beta.2 (#1255).

## Context

The session search body is the first text block of each record, 500
characters per record, up to about 8 KB (`readSessionFile`). A pull request,
merge request or issue number discussed later in a long session, or quoted
only in a tool call or its output, is not in the index, so searching
`#13423` does not find the session that handled it. Indexing the whole
conversation would multiply the index size and the trigram work of every
query; it stays a follow-up of #1255.

## Decision

While reading a transcript, extract compact identifiers from every record that
the read keeps (user and assistant text, `tool_use` inputs, `tool_result`
text; message text and tool calls for Codex): `#N` and `!N` of 2 to 6 digits,
GitHub and GitLab pull request, merge request and issue URLs normalised to
`#N` or `!N` plus `owner/repo#N` or `owner/repo!N`, and full UUIDs other than
the session's own. Keep them deduplicated, newest first, at most 4096
characters, and append them to the search body after the text, behind the
marker `\n[refs] `. The text is cut first when the body would exceed the
existing 32768-character cap. No column, table or FTS schema changes: the refs
are part of the `body` column, so the snippet shows them and the existing
`search_fts` rows take them as they are rewritten.

Appended lines keep the refs current without a full read: the header-only
refresh already scans the appended bytes for the message count
(`readMessageCount`), and passes every parsed entry to the extractor. The new
refs are sent as an `upsertSearchEntries` entry flagged `refsMerge`, which the
store merges into the stored body in place. It goes through the existing
writer command, so project-deletion fencing still sees a session write.

`SESSION_CONTENT_INDEX_VERSION` goes from 1 to 2 with a new golden digest.
At the first start of this version every local folder's seal is out of date,
so the startup scan re-reads every transcript in the scan worker, in the
background. The sidebar shows the cached rows meanwhile.

## Consequences

- Measured on a copy of the live database (24/11), re-reading its 623 local
  Claude sessions (12 top-level, 611 subagents; 4.8 GB of transcripts) and
  merging their refs: every one had refs, 41 939 in all, 448 characters per
  session on average, 4 093 at most (the cap). After `VACUUM` the database grew
  from 213.9 MB to 222.4 MB (+8.4 MB, +3.9 %); `search_fts_data` from 190.0 to
  198.2 MB, `search_content` from 15.6 to 15.8 MB. The 2 768 remote-host rows
  and the 427 Codex rows of that database were not re-read; at the same rate
  per session they would add about 43 MB more (an extrapolation, not a
  measurement; most of them are subagent transcripts). A `"1233"` query over the result
  took 3 ms.
- The one-time re-read is a full read of every transcript: the measurement
  above took 98 s on one thread for 4.8 GB, extraction and index writes
  included; the startup scan adds the remote mirrors and Codex rollouts. It
  runs in the scan worker, off the window's thread (not measured in the app).
  Until it finishes,
  sessions not yet re-read have no refs.
- Only the identifiers are kept from the rest of a session; words past the
  opening are still not searchable. Hex colours written as `#333` and similar
  short numbers are kept as noise; the cap bounds them.
- Remote host mirrors are read by the same `readSessionFile`, so their full
  reads carry refs too.

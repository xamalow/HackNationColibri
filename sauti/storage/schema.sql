-- Sauti Host SQLite schema. Shared file: claim it in the team room before editing.

-- W1: every confirmed farm sheet is a new version, never an in-place update,
-- so W5 can detect changes and we keep an audit of what Noor actually said.
CREATE TABLE IF NOT EXISTS farm_sheet_versions (
    version      INTEGER PRIMARY KEY AUTOINCREMENT,
    data         TEXT    NOT NULL,  -- FarmSheet as JSON
    content_hash TEXT    NOT NULL,  -- sha256 of the canonical JSON
    source       TEXT    NOT NULL,  -- e.g. 'w1_voice', 'w1_text'
    transcript   TEXT,              -- what Noor said, for audit
    created_at   TEXT    NOT NULL   -- ISO 8601 UTC
);

-- ---------------------------------------------------------------- W2 and shared core
-- Owner: xam-claude (W2). States are listed in sauti/storage/states.py.
PRAGMA foreign_keys = ON;

-- Every inbound item from any channel, stored before any model touches it.
-- Tourist text is untrusted data: it is stored and shown, never executed.
CREATE TABLE IF NOT EXISTS messages (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    channel           TEXT    NOT NULL,  -- sms, whatsapp, voicemail, missed_call, email_airbnb, email_gyg, gyg_api
    external_id       TEXT    NOT NULL,  -- id given by the channel, for dedupe
    sender_ref        TEXT    NOT NULL,  -- opaque reply address (phone, thread id), never shown to the LLM
    received_at       TEXT    NOT NULL,  -- ISO 8601 UTC
    text_original     TEXT,              -- message text, or voicemail transcript
    audio_path        TEXT,              -- voicemail recording, if any
    lang              TEXT,              -- detected source language (ISO 639-1)
    text_sw           TEXT,              -- Swahili translation for Noor
    intent            TEXT,              -- price, date, directions, booking, other
    intent_confidence REAL,
    requested_date    TEXT,              -- ISO date, parsed by code
    party_size        INTEGER,           -- parsed by code
    booking_ref       TEXT,              -- platform booking reference, if any
    synthetic         INTEGER NOT NULL DEFAULT 0,
    state             TEXT    NOT NULL,  -- RECEIVED, PROCESSED
    UNIQUE (channel, external_id)
);

-- What the agent proposes. Nothing leaves the farm without an approved proposal.
CREATE TABLE IF NOT EXISTS proposals (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    short_id     TEXT    NOT NULL,  -- A, B, C... what Noor says when she approves
    kind         TEXT    NOT NULL,  -- reply, callback, needs_noor
    message_id   INTEGER NOT NULL REFERENCES messages(id),
    content      TEXT    NOT NULL,  -- canonical JSON of what will be sent or done
    content_hash TEXT    NOT NULL,  -- sha256 of content; approvals are tied to it
    version      INTEGER NOT NULL DEFAULT 1,
    state        TEXT    NOT NULL,
    created_at   TEXT    NOT NULL,
    updated_at   TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_proposals_message ON proposals(message_id);
CREATE INDEX IF NOT EXISTS idx_proposals_state ON proposals(state);
-- A short ID names exactly one open proposal at a time.
CREATE UNIQUE INDEX IF NOT EXISTS uq_proposals_open_short_id
    ON proposals(short_id) WHERE state IN ('PROPOSED', 'APPROVED');

-- Noor's yes, tied to one proposal and one exact content. A content change voids it.
CREATE TABLE IF NOT EXISTS approvals (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    proposal_id  INTEGER NOT NULL REFERENCES proposals(id),
    content_hash TEXT    NOT NULL,
    approved_by  TEXT    NOT NULL,  -- 'noor' (voice or keypad), for audit
    approved_at  TEXT    NOT NULL,
    voided_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_approvals_proposal ON approvals(proposal_id);

-- Audit trail of every state change.
CREATE TABLE IF NOT EXISTS proposal_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    proposal_id INTEGER NOT NULL REFERENCES proposals(id),
    from_state  TEXT,
    to_state    TEXT    NOT NULL,
    note        TEXT,
    at          TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_proposal_events_proposal ON proposal_events(proposal_id);

-- One calendar for every channel: capacity is always computed over all of them.
CREATE TABLE IF NOT EXISTS bookings (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    slot_date    TEXT    NOT NULL,  -- ISO date (one tour per day for now)
    party_size   INTEGER NOT NULL CHECK (party_size >= 1),
    channel      TEXT    NOT NULL,  -- direct, getyourguide, airbnb
    external_ref TEXT,              -- platform booking reference
    proposal_id  INTEGER REFERENCES proposals(id),
    status       TEXT    NOT NULL,  -- HELD, CONFIRMED, CANCELLED
    created_at   TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bookings_slot ON bookings(slot_date, status);
CREATE INDEX IF NOT EXISTS idx_bookings_proposal ON bookings(proposal_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_bookings_external
    ON bookings(channel, external_ref) WHERE external_ref IS NOT NULL;

-- Days nobody may book (sync failure in W5, Noor unavailable...). Fail closed.
CREATE TABLE IF NOT EXISTS slot_blocks (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    slot_date  TEXT NOT NULL,
    reason     TEXT NOT NULL,
    created_at TEXT NOT NULL,
    lifted_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_slot_blocks_date ON slot_blocks(slot_date);

-- Outbound queue. One row per approved message, one idempotency key per row.
CREATE TABLE IF NOT EXISTS outbox (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    proposal_id     INTEGER NOT NULL UNIQUE REFERENCES proposals(id),
    channel         TEXT    NOT NULL,
    recipient_ref   TEXT    NOT NULL,
    body            TEXT    NOT NULL,
    idempotency_key TEXT    NOT NULL UNIQUE,
    status          TEXT    NOT NULL,  -- QUEUED, SENDING, SENT, DELIVERED, FAILED, UNCERTAIN
    attempts        INTEGER NOT NULL DEFAULT 0,
    transport_ref   TEXT,
    last_error      TEXT,
    created_at      TEXT    NOT NULL,
    updated_at      TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox(status);

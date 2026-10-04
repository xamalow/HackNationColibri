"""Generate contract fixtures and digest vectors from the Python reference canonicalizer.

    .venv/Scripts/python contracts/tools/make_fixtures.py

Every file it writes is synthetic and says so. Re-run after any schema change; the
test suite fails if a fixture's digest no longer matches.

r1.1 (2026-10-04): the r1.0 fixtures below are generated exactly as before and their
digests must not move. r1.1 adds a voice-channel envelope, an sms_code approval
record that approves it, an owner alert, and bad cases for each new rule.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from sauti.core.canon import (  # noqa: E402
    ENVELOPE_DOMAIN,
    OWNER_ALERT_DOMAIN,
    canonical_bytes,
    digest,
    source_text_hash,
)

FIX = ROOT / "contracts" / "fixtures"
TENANT = "demo-farm-001"  # the business; the owner is demo-noor-001. Distinct on purpose.
NOTE = "Synthetic fixture. Not a real customer, not native-reviewed Swahili, not a send receipt."


def write(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")


def with_digest(envelope: dict, domain: bytes = ENVELOPE_DOMAIN) -> dict:
    body = {k: v for k, v in envelope.items() if k != "digest"}
    return {**body, "digest": digest(domain, body)}


def main() -> None:
    # Immutable synthetic source text, Swahili with a multi-byte character so byte offsets are exercised.
    source_text = "Kahawa ilikuwa nzuri sana, lakini maelekezo ya kufika yalikuwa magumu — tulipotea njia."
    source = {
        "synthetic": True,
        "note": NOTE,
        "source_id": "synthetic-review-001",
        "source_type": "direct_review",
        "language": "sw",
        "text": source_text,
        "content_hash": source_text_hash(source_text),
    }
    write(FIX / "sources" / "synthetic-review-001.json", source)

    raw = source_text.encode("utf-8")
    quote = "maelekezo ya kufika yalikuwa magumu"
    start = raw.index(quote.encode("utf-8"))
    end = start + len(quote.encode("utf-8"))

    send_message = with_digest({
        "schema": "sauti.action_envelope",
        "schema_version": "1.0.0",
        "action_id": "42424242-1234-4abc-8123-abcdefabcdef",
        "tenant_id": TENANT,
        "kind": "send_message",
        "created_at": "2026-10-03T20:00:00Z",
        "valid_until": "2026-10-04T20:00:00Z",
        "fact_revision": 1,
        "recipient": {"channel": "simulated", "address": "SIMULATED:guest-001", "language": "sw"},
        "payload": {
            "type": "message",
            "body": "Asante kwa kututembelea. Ni sehemu gani ya maelekezo iliyokuwa ngumu?",
            "body_language": "sw",
            "in_reply_to": "synthetic-review-001",
            "template_id": "ask_which_direction_step",
        },
        "evidence": [{
            "source_id": "synthetic-review-001",
            "content_hash": source["content_hash"],
            "span": {"start": start, "end": end},
            "quote": quote,
        }],
        "preview": {
            "text": "SIMULATED tu. Tuma ujumbe huu kwa mgeni 001: Asante kwa kututembelea. Ni sehemu gani ya maelekezo iliyokuwa ngumu? (Haujakaguliwa na mzungumzaji wa Kiswahili.)",
            "render_locale": "sw-KE",
        },
        "authority": {"level": "owner", "owner_context_required": True},
    })
    write(FIX / "good" / "send_message_simulated.json", send_message)

    record_payment = with_digest({
        "schema": "sauti.action_envelope",
        "schema_version": "1.0.0",
        "action_id": "7a7a7a7a-5678-4def-9abc-0123456789ab",
        "tenant_id": TENANT,
        "kind": "record_payment",
        "created_at": "2026-10-03T20:05:00Z",
        "valid_until": "2026-10-03T21:05:00Z",
        "fact_revision": 1,
        "recipient": {"channel": "local", "address": "owner", "language": "sw"},
        "payload": {
            "type": "record_payment",
            "booking_id": "synthetic-booking-001",
            "money": {"amount_minor": 200000, "currency": "KES", "exponent": 2},
            "method": "mpesa",
            "reported_by": "owner",
        },
        "evidence": [],
        "preview": {
            "text": "Thomas, ziara Jumamosi tarehe nne Oktoba, watu wawili. Niandike malipo ya shilingi elfu mbili? (Later phase fixture.)",
            "render_locale": "sw-KE",
        },
        "authority": {"level": "owner", "owner_context_required": True},
    })
    write(FIX / "good" / "record_payment_owner_record.json", record_payment)

    approval = {
        "schema": "sauti.approval_record",
        "schema_version": "1.0.0",
        "approval_id": "11111111-2222-4333-8444-555555555555",
        "action_id": send_message["action_id"],
        "digest": send_message["digest"],
        "fact_revision": 1,
        "decision": "approved",
        "decided_at": "2026-10-03T20:10:00Z",
        "owner_context": {
            "owner_id": "demo-noor-001",
            "device_id": "demo-android-001",
            "unlock": "pin",
            "confirmation": "tap",
            "session_id": "local-session-0001",
            "authenticated_at": "2026-10-03T20:08:00Z",
        },
    }
    write(FIX / "good" / "approval_send_message.json", approval)

    # ---- r1.1 (2026-10-04): voice channel, sms_code approval, owner alert. Synthetic number, synthetic ids.
    send_message_voice = with_digest({
        "schema": "sauti.action_envelope",
        "schema_version": "1.1.0",
        "action_id": "5a5a5a5a-9abc-4def-8abc-fedcba987654",
        "tenant_id": TENANT,
        "kind": "send_message",
        "created_at": "2026-10-04T08:00:00Z",
        "valid_until": "2026-10-05T08:00:00Z",
        "fact_revision": 1,
        "recipient": {"channel": "voice", "address": "+254700000001", "language": "sw"},
        "payload": {
            "type": "message",
            "body": "Habari. Shamba la Noor linathibitisha ziara yako Jumamosi tarehe nne Oktoba saa tatu asubuhi. Asante.",
            "body_language": "sw",
            "booking_id": "synthetic-booking-002",
            "template_id": "confirm_visit_call",
            "clip_keys": ["call.greeting", "call.visit_confirmed_sat_4_oct_0900", "call.thanks"],
        },
        "evidence": [],
        "preview": {
            "text": "SIMU kwa +254700000001 (klipu 3): Habari. Shamba la Noor linathibitisha ziara yako Jumamosi tarehe nne Oktoba saa tatu asubuhi. Asante. (Nambari ya mfano.)",
            "render_locale": "sw-KE",
        },
        "authority": {"level": "owner", "owner_context_required": True},
    })
    write(FIX / "good" / "send_message_voice.json", send_message_voice)

    approval_sms_code = {
        "schema": "sauti.approval_record",
        "schema_version": "1.1.0",
        "approval_id": "22222222-3333-4444-8555-666666666666",
        "action_id": send_message_voice["action_id"],
        "digest": send_message_voice["digest"],
        "fact_revision": 1,
        "decision": "approved",
        "decided_at": "2026-10-04T08:12:00Z",
        "owner_context": {
            "owner_id": "demo-noor-001",
            "device_id": "demo-basic-phone-001",
            "unlock": "sms_code",
            "confirmation": "text",
            "session_id": "sms-session-0001",
            "authenticated_at": "2026-10-04T08:12:00Z",
            "challenge_id": "challenge-0001",
        },
    }
    write(FIX / "good" / "approval_sms_code.json", approval_sms_code)

    owner_alert = with_digest({
        "schema": "sauti.owner_alert",
        "schema_version": "1.1.0",
        "alert_id": "33333333-4444-4555-8666-777777777777",
        "tenant_id": TENANT,
        "kind": "booking_received",
        "about": {"booking_id": "synthetic-booking-002", "event_id": "synthetic-gyg-email-001"},
        "created_at": "2026-10-04T07:55:00Z",
        "text": "Ziara mpya: Jumamosi 4 Oktoba, watu 2, kupitia GetYourGuide. Nambari ya ziara: synthetic-booking-002.",
        "text_language": "sw",
        "clip_keys": ["alert.new_booking"],
    }, OWNER_ALERT_DOMAIN)
    write(FIX / "good" / "owner_alert_booking.json", owner_alert)

    # Bad fixtures: each must be rejected for the stated reason.
    bad = []
    tampered = dict(send_message)
    tampered["payload"] = {**send_message["payload"], "body": send_message["payload"]["body"] + " Bure!"}
    bad.append(("digest_mismatch_after_edit", tampered, "digest no longer matches the content: edited after approval"))
    float_money = json.loads(json.dumps(record_payment))
    float_money["payload"]["money"] = {"amount_minor": 2000.5, "currency": "KES", "exponent": 2}
    bad.append(("float_money", float_money, "money must be an integer in minor units"))
    unknown = dict(send_message)
    unknown["priority"] = "high"
    bad.append(("unknown_field", unknown, "unknown members are rejected before hashing"))
    ts = dict(send_message)
    ts["created_at"] = "2026-10-03T20:00:00+00:00"
    bad.append(("timestamp_not_utc_z", ts, "timestamps are RFC 3339 UTC with a literal Z"))
    quote_altered = json.loads(json.dumps(send_message))
    quote_altered["evidence"][0]["quote"] = "maelekezo ya kufika yalikuwa rahisi"
    quote_altered = with_digest(quote_altered)
    bad.append(("evidence_quote_altered", quote_altered, "schema-valid but the quote is not the exact UTF-8 slice: evidence validation must reject it"))
    no_owner_ctx = dict(approval)
    del no_owner_ctx["owner_context"]
    bad.append(("approval_without_owner_context", no_owner_ctx, "hash equality is not owner authentication"))
    voice_only = json.loads(json.dumps(approval))
    voice_only["owner_context"]["unlock"] = "voice_confirm"
    bad.append(("approval_voice_confirm_as_unlock", voice_only, "voice or text confirmation alone never authenticates an owner session"))
    kind_mismatch = json.loads(json.dumps(send_message))
    kind_mismatch["kind"] = "record_payment"
    kind_mismatch = with_digest(kind_mismatch)
    bad.append(("kind_payload_channel_mismatch", kind_mismatch, "kind record_payment with a message payload on an sms/simulated channel: the allOf binding rejects it"))
    impossible_ts = json.loads(json.dumps(send_message))
    impossible_ts["created_at"] = "2026-99-99T25:61:61Z"
    impossible_ts = with_digest(impossible_ts)
    bad.append(("timestamp_impossible_fields", impossible_ts, "month 99, day 99, hour 25: the bounded pattern rejects it"))
    feb30 = json.loads(json.dumps(send_message))
    feb30["created_at"] = "2026-02-30T20:00:00Z"
    feb30 = with_digest(feb30)
    bad.append(("timestamp_not_a_calendar_date", feb30, "passes the pattern; code must reject a non-existent date before hashing"))
    window = json.loads(json.dumps(send_message))
    window["valid_until"] = window["created_at"]
    window = with_digest(window)
    bad.append(("validity_window_empty", window, "valid_until must be after created_at; code check, not expressible in the schema"))
    big_rev = json.loads(json.dumps(send_message))
    big_rev["fact_revision"] = 2**53
    big_rev["digest"] = "0" * 64  # the canonicalizer refuses to hash it, which is the point
    bad.append(("fact_revision_above_safe_integer", big_rev, "2^53 is above the schema maximum and outside JS exact integers"))

    # r1.1 rules
    voice_on_10 = json.loads(json.dumps(send_message_voice))
    voice_on_10["schema_version"] = "1.0.0"
    voice_on_10 = with_digest(voice_on_10)
    bad.append(("voice_channel_on_schema_1_0", voice_on_10, "a 1.0.0 document cannot carry r1.1 features: the voice channel needs schema_version 1.1.0"))
    voice_no_clips = json.loads(json.dumps(send_message_voice))
    del voice_no_clips["payload"]["clip_keys"]
    voice_no_clips = with_digest(voice_no_clips)
    bad.append(("voice_without_clip_keys", voice_no_clips, "a voice call plays exactly the pinned clips; clip_keys is required on the voice channel"))
    clips_on_sms = json.loads(json.dumps(send_message))
    clips_on_sms["schema_version"] = "1.1.0"
    clips_on_sms["payload"]["clip_keys"] = ["call.greeting"]
    clips_on_sms = with_digest(clips_on_sms)
    bad.append(("clip_keys_without_voice", clips_on_sms, "only the voice channel carries clips"))
    voice_book = json.loads(json.dumps(send_message_voice))
    voice_book["kind"] = "publish_listing"
    voice_book = with_digest(voice_book)
    bad.append(("voice_channel_for_publish_listing", voice_book, "voice is a send_message channel only; listings and bookings never go by call"))
    sms_on_10 = json.loads(json.dumps(approval_sms_code))
    sms_on_10["schema_version"] = "1.0.0"
    bad.append(("approval_sms_code_on_schema_1_0", sms_on_10, "unlock sms_code needs schema_version 1.1.0; an r1.0 validator rightly refuses it"))
    sms_no_challenge = json.loads(json.dumps(approval_sms_code))
    del sms_no_challenge["owner_context"]["challenge_id"]
    bad.append(("approval_sms_code_without_challenge", sms_no_challenge, "an sms_code record names the one-time-code challenge it consumed"))
    sms_tap = json.loads(json.dumps(approval_sms_code))
    sms_tap["owner_context"]["confirmation"] = "tap"
    bad.append(("approval_sms_code_with_tap_confirmation", sms_tap, "with sms_code the SMS reply is the confirmation: text only"))
    pin_challenge = json.loads(json.dumps(approval))
    pin_challenge["schema_version"] = "1.1.0"
    pin_challenge["owner_context"]["challenge_id"] = "challenge-0001"
    bad.append(("approval_pin_with_challenge_id", pin_challenge, "only an sms_code record names a challenge"))
    alert_as_action = json.loads(json.dumps(owner_alert))
    bad.append(("owner_alert_as_action", alert_as_action, "an owner alert is not an action envelope: it has no kind, recipient, payload or authority an approval could bind to, so verifyEnvelope and decideApproval reject it by construction"))
    alert_with_approval = json.loads(json.dumps(owner_alert))
    alert_with_approval["approval"] = {"decision": "approved"}
    alert_with_approval = with_digest(alert_with_approval, OWNER_ALERT_DOMAIN)
    bad.append(("owner_alert_with_approval_member", alert_with_approval, "alerts carry no approval, ever; unknown members are rejected"))
    alert_empty_about = json.loads(json.dumps(owner_alert))
    alert_empty_about["about"] = {}
    alert_empty_about = with_digest(alert_empty_about, OWNER_ALERT_DOMAIN)
    bad.append(("owner_alert_about_nothing", alert_empty_about, "an alert names what it is about: booking, event or action"))

    for stale in (FIX / "bad").glob("*.json"):
        stale.unlink()
    for name, data, reason in bad:
        case = {"synthetic": True, "expect": "reject", "reason": reason, "input": data}
        if name == "owner_alert_as_action":
            case["validate_as"] = "action_envelope"  # a well-formed alert; the rejection is as an ACTION
        write(FIX / "bad" / f"{name}.json", case)

    vectors = []
    for env in (send_message, record_payment, send_message_voice):
        body = {k: v for k, v in env.items() if k != "digest"}
        vectors.append({
            "name": env["kind"] if env["schema_version"] == "1.0.0" else f"{env['kind']}_{env['recipient']['channel']}_r1_1",
            "envelope_without_digest": body,
            "canonical_utf8_hex": canonical_bytes(body).hex(),
            "domain": ENVELOPE_DOMAIN.decode(),
            "digest": env["digest"],
        })
    alert_vectors = []
    for alert in (owner_alert,):
        body = {k: v for k, v in alert.items() if k != "digest"}
        alert_vectors.append({
            "name": alert["kind"],
            "alert_without_digest": body,
            "canonical_utf8_hex": canonical_bytes(body).hex(),
            "domain": OWNER_ALERT_DOMAIN.decode(),
            "digest": alert["digest"],
        })
    write(FIX / "digest-vectors.json", {"synthetic": True, "note": NOTE, "vectors": vectors, "alert_vectors": alert_vectors})
    print(f"wrote fixtures under {FIX}")


if __name__ == "__main__":
    main()

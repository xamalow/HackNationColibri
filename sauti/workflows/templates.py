"""The fixed list of W2 reply templates, and Noor's Swahili summary of each proposal.

Templates are hand-written in every demo language (en, de, fr, sw), so a reply never
depends on machine translation; NLLB is only needed for other languages. Every value
put in a template comes from `Facts`, computed by code from the farm sheet and calendar.
Tourist text is never put in a template.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import date, time
from typing import Literal

from sauti.lang.swahili import number_to_words, people_to_words

TemplateKey = Literal[
    "price", "price_total", "date_open", "date_full", "date_closed", "ask_date",
    "booking_offer", "ask_details", "directions", "callback",
]
TEMPLATE_LANGS = ("en", "de", "fr", "sw")


@dataclass(frozen=True)
class Facts:
    """Everything a reply may state. Built by code only."""

    price_pp: int | None = None
    total: int | None = None
    party_size: int | None = None
    day: date | None = None
    seats_left: int | None = None
    start: time | None = None
    end: time | None = None
    open_days: tuple[str, ...] | None = None
    directions: str | None = None  # already in the tourist's language

    def as_json(self) -> dict[str, object]:
        out: dict[str, object] = {}
        for key, value in asdict(self).items():
            if isinstance(value, (date, time)):
                value = value.isoformat()
            elif isinstance(value, tuple):
                value = list(value)
            out[key] = value
        return out


_MONTHS = {
    "en": ["January", "February", "March", "April", "May", "June", "July", "August", "September",
           "October", "November", "December"],
    "de": ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September",
           "Oktober", "November", "Dezember"],
    "fr": ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre",
           "octobre", "novembre", "décembre"],
    "sw": ["Januari", "Februari", "Machi", "Aprili", "Mei", "Juni", "Julai", "Agosti", "Septemba",
           "Oktoba", "Novemba", "Desemba"],
}
_DAYS = {
    "en": ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"],
    "de": ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"],
    "fr": ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"],
    "sw": ["Jumatatu", "Jumanne", "Jumatano", "Alhamisi", "Ijumaa", "Jumamosi", "Jumapili"],
}
_DAY_INDEX = {"mon": 0, "tue": 1, "wed": 2, "thu": 3, "fri": 4, "sat": 5, "sun": 6}


def fmt_date(d: date, lang: str) -> str:
    day_name, month = _DAYS[lang][d.weekday()], _MONTHS[lang][d.month - 1]
    if lang == "de":
        return f"{day_name}, {d.day}. {month} {d.year}"
    if lang == "sw":
        return f"{day_name}, tarehe {d.day} {month} {d.year}"
    return f"{day_name} {d.day} {month} {d.year}"


def fmt_days(days: tuple[str, ...], lang: str) -> str:
    names = [_DAYS[lang][_DAY_INDEX[d]] for d in sorted(days, key=_DAY_INDEX.__getitem__)]
    joiner = {"en": " and ", "de": " und ", "fr": " et ", "sw": " na "}[lang]
    return names[0] if len(names) == 1 else ", ".join(names[:-1]) + joiner + names[-1]


def fmt_time(t: time) -> str:
    return t.strftime("%H:%M")


# Placeholders: {price_pp} {total} {party} {date} {start} {end} {days} {directions}
TEMPLATES: dict[TemplateKey, dict[str, str]] = {
    "price": {
        "en": "Hello! Our coffee farm tour costs {price_pp} KES per person. Let us know your date and number of people.",
        "de": "Hallo! Unsere Kaffeefarm-Tour kostet {price_pp} KES pro Person. Nennen Sie uns gern Datum und Personenzahl.",
        "fr": "Bonjour ! La visite de notre ferme de café coûte {price_pp} KES par personne. Indiquez-nous la date et le nombre de personnes.",
        "sw": "Habari! Ziara ya shamba letu la kahawa ni KES {price_pp} kwa mtu mmoja. Tafadhali tuambie tarehe na idadi ya watu.",
    },
    "price_total": {
        "en": "Hello! Our coffee farm tour costs {price_pp} KES per person, so {total} KES for {party} people.",
        "de": "Hallo! Unsere Kaffeefarm-Tour kostet {price_pp} KES pro Person, also {total} KES für {party} Personen.",
        "fr": "Bonjour ! La visite coûte {price_pp} KES par personne, soit {total} KES pour {party} personnes.",
        "sw": "Habari! Ziara ni KES {price_pp} kwa mtu mmoja, kwa hiyo KES {total} kwa watu {party}.",
    },
    "date_open": {
        "en": "Yes, we can welcome {party} people on {date}. The tour runs from {start} to {end}.",
        "de": "Ja, am {date} können wir {party} Personen empfangen. Die Tour dauert von {start} bis {end} Uhr.",
        "fr": "Oui, nous pouvons accueillir {party} personnes le {date}. La visite a lieu de {start} à {end}.",
        "sw": "Ndiyo, tunaweza kupokea watu {party} {date}. Ziara ni kuanzia {start} hadi {end}.",
    },
    "date_full": {
        "en": "Sorry, we are fully booked on {date}. Would another day suit you?",
        "de": "Leider sind wir am {date} ausgebucht. Passt Ihnen ein anderer Tag?",
        "fr": "Désolés, nous sommes complets le {date}. Un autre jour vous conviendrait-il ?",
        "sw": "Samahani, {date} hakuna nafasi. Siku nyingine itakufaa?",
    },
    "date_closed": {
        "en": "Sorry, there is no tour on {date}. We run tours on {days}.",
        "de": "Leider gibt es am {date} keine Tour. Touren finden {days} statt.",
        "fr": "Désolés, il n'y a pas de visite le {date}. Les visites ont lieu le {days}.",
        "sw": "Samahani, hakuna ziara {date}. Ziara ni siku za {days}.",
    },
    "ask_date": {
        "en": "Thank you for your message! Which date would you like to visit, and how many people are you?",
        "de": "Vielen Dank für Ihre Nachricht! An welchem Datum möchten Sie kommen, und wie viele Personen sind Sie?",
        "fr": "Merci pour votre message ! À quelle date souhaitez-vous venir, et combien de personnes êtes-vous ?",
        "sw": "Asante kwa ujumbe wako! Ungependa kuja tarehe gani, na mko watu wangapi?",
    },
    "booking_offer": {
        "en": "Thank you! We have reserved the tour for {party} people on {date}, from {start} to {end}. The price is {total} KES ({price_pp} KES per person).",
        "de": "Vielen Dank! Wir haben die Tour für {party} Personen am {date} von {start} bis {end} Uhr reserviert. Der Preis beträgt {total} KES ({price_pp} KES pro Person).",
        "fr": "Merci ! Nous avons réservé la visite pour {party} personnes le {date}, de {start} à {end}. Le prix est de {total} KES ({price_pp} KES par personne).",
        "sw": "Asante! Tumehifadhi ziara kwa watu {party} {date}, kuanzia {start} hadi {end}. Bei ni KES {total} (KES {price_pp} kwa mtu mmoja).",
    },
    "ask_details": {
        "en": "Thank you, we would be happy to welcome you! Please tell us the date and the number of people.",
        "de": "Vielen Dank, wir freuen uns auf Sie! Bitte nennen Sie uns das Datum und die Personenzahl.",
        "fr": "Merci, nous serions ravis de vous accueillir ! Merci de nous indiquer la date et le nombre de personnes.",
        "sw": "Asante, tutafurahi kukukaribisha! Tafadhali tuambie tarehe na idadi ya watu.",
    },
    "directions": {
        "en": "Here is how to find our farm: {directions}",
        "de": "So finden Sie unsere Farm: {directions}",
        "fr": "Voici comment trouver notre ferme : {directions}",
        "sw": "Hivi ndivyo utakavyofika shambani kwetu: {directions}",
    },
    "callback": {
        "en": "Hello, this is Noor's coffee farm. Sorry we missed your call. Please send us a text message with your question, the date and the number of people.",
        "de": "Hallo, hier ist Noors Kaffeefarm. Leider haben wir Ihren Anruf verpasst. Bitte schreiben Sie uns eine SMS mit Ihrer Frage, dem Datum und der Personenzahl.",
        "fr": "Bonjour, ici la ferme de café de Noor. Désolés d'avoir manqué votre appel. Envoyez-nous un SMS avec votre question, la date et le nombre de personnes.",
        "sw": "Habari, hapa ni shamba la kahawa la Noor. Samahani hatukupokea simu yako. Tafadhali tutumie ujumbe mfupi wenye swali lako, tarehe na idadi ya watu.",
    },
}


def render(key: TemplateKey, lang: str, facts: Facts) -> str:
    values = {
        "price_pp": facts.price_pp, "total": facts.total, "party": facts.party_size,
        "date": fmt_date(facts.day, lang) if facts.day else None,
        "start": fmt_time(facts.start) if facts.start else None,
        "end": fmt_time(facts.end) if facts.end else None,
        "days": fmt_days(facts.open_days, lang) if facts.open_days else None,
        "directions": facts.directions,
    }
    return TEMPLATES[key][lang].format(**{k: v for k, v in values.items() if v is not None})


# ---------------------------------------------------------------- Noor's summary (Swahili, words for TTS)

LANG_NAMES_SW = {"en": "Kiingereza", "de": "Kijerumani", "fr": "Kifaransa", "sw": "Kiswahili"}
CHANNEL_NAMES_SW = {
    "sms": "SMS", "whatsapp": "WhatsApp", "voicemail": "ujumbe wa sauti", "missed_call": "simu ambayo haikupokelewa",
    "email_airbnb": "Airbnb", "email_gyg": "GetYourGuide", "gyg_api": "GetYourGuide",
}
_ANSWER_SW: dict[TemplateKey, str] = {
    "price": "Jibu: bei ni shilingi {price_pp} kwa mtu mmoja.",
    "price_total": "Jibu: bei ni shilingi {total} kwa watu {party}.",
    "date_open": "Jibu: nafasi ipo {date} kwa watu {party}.",
    "date_full": "Jibu: hakuna nafasi {date}.",
    "date_closed": "Jibu: hakuna ziara {date}.",
    "ask_date": "Jibu: tunamwuliza tarehe na idadi ya watu.",
    "booking_offer": "Jibu: tunahifadhi nafasi ya watu {party} {date}, jumla shilingi {total}. Ukikubali, nafasi itazuiwa kila mahali.",
    "ask_details": "Jibu: tunamwuliza tarehe na idadi ya watu.",
    "directions": "Jibu: tunamtumia maelekezo ya kufika shambani.",
    "callback": "Jibu: tunamwomba atume ujumbe mfupi wenye swali lake.",
}


def _sw_date(d: date) -> str:
    return f"{_DAYS['sw'][d.weekday()]} tarehe {number_to_words(d.day)} {_MONTHS['sw'][d.month - 1]}"


def noor_summary(short_id: str, channel: str, lang: str | None, key: TemplateKey, facts: Facts) -> str:
    who = f"Ombi {short_id}. Mgeni kupitia {CHANNEL_NAMES_SW.get(channel, channel)}"
    if lang in LANG_NAMES_SW:
        who += f", kwa {LANG_NAMES_SW[lang]}"
    answer = _ANSWER_SW[key].format(
        price_pp=number_to_words(facts.price_pp) if facts.price_pp else "",
        total=number_to_words(facts.total) if facts.total else "",
        party=people_to_words(facts.party_size) if facts.party_size else "",
        date=_sw_date(facts.day) if facts.day else "",
    )
    return f"{who}. {answer} Nitume? Sema ndiyo {short_id} au hapana {short_id}."


def needs_noor_summary(short_id: str, channel: str, lang: str | None, reason_sw: str, text_for_noor: str | None) -> str:
    who = f"Ombi {short_id}. Ujumbe kupitia {CHANNEL_NAMES_SW.get(channel, channel)}"
    if lang in LANG_NAMES_SW:
        who += f", kwa {LANG_NAMES_SW[lang]}"
    said = f" Ujumbe unasema: «{text_for_noor}»." if text_for_noor else ""
    return f"{who}. {reason_sw}{said} Ungependa nimjibu nini?"

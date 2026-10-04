# Sauti Host: buyer, economics and distribution

Lane: Cosme (buyer/economics/distribution), addendum r1.0. Draft by cosme-claude, **not yet signed off by Cosme**.
Status labels follow the addendum: VERIFIED (source checked), MEASURED (we ran it), PROPOSED (our design choice), UNKNOWN.
All sources below are secondary (press, vendor pages) found 2026-10-03; primary documents still to pull where marked.

## 1. Bottom line

- **Noor cannot be the buyer.** Her tour income is small and irregular, and a capable phone already costs a large share of a rural woman's income (E-05). Any price she pays herself must stay far below the value of one visitor.
- **The cooperative is the distribution channel and the most plausible payer.** Kenya's coffee sector is ~800,000 smallholders in ~500 cooperatives (E-03). Coops already meet farmers at the factory, pay them, and have field officers who can side-load a model pack by USB, so there is no data cost for the 1.3+ GB download (E-09).
- **Development programs can fund the pilot.** The World Bank NAVCDP (US$250M IDA) explicitly covers the coffee value chain and digital agriculture for 500,000 farmers (E-07). Fundable on paper; we have no contact or commitment (UNKNOWN).
- **The value we can defend is direct bookings.** OTAs keep 20–30% (E-02). Each tourist message answered quickly and correctly in their language is a direct booking that keeps the full fee.

## 2. Evidence packets

| E-ID | Question | Source + date | Fact | Status | Limitation | Implication |
|---|---|---|---|---|---|---|
| E-01 | What do coffee farm tours sell for? | [Expedia Fairview listing](https://www.expedia.com/things-to-do/half-day-visit-to-a-fairview-estate-coffee-farm-tour.a49276700.activity-details), [africasafaritrips](https://africasafaritrips.com/activity/visit-a-coffee-farm/), 2026-10-03 | Commercial estate tours near Nairobi: ~US$40–150 per person, often with transfer | VERIFIED (secondary) | Large estates near Nairobi, not smallholders in the highlands | Smallholder price is UNKNOWN; we assume KES 2,000/person in demo data, to replace with field data |
| E-02 | What do OTAs keep? | [GetYourGuide supply page](https://www.getyourguide.supply/join/how-much-does-getyourguide-charge), [Arival](https://arival.travel/article/getyourguide-commission-increasing-for-some-operators) | GetYourGuide commission 20–30% by country, raised toward 30% for some operators from July 2025 | VERIFIED (secondary) | Kenya rate not public; suppliers sign confidentiality | Value of a direct booking = 20–30% of the ticket kept by Noor |
| E-03 | How big is the coop channel? | African Fine Coffees Association, via [The Standard](https://thestandard.ke/business/amp/world/article/2001508461/coffee-farming-provides-lifeline-for-kenyas-central-region) | ~800,000 smallholders, ~500 cooperatives | VERIFIED (secondary) | Number of farms that already host visitors is UNKNOWN, surely a small fraction | Target = coops in tourist-reachable counties, not all 500 |
| E-04 | How much does coffee pay? | [Food Business MEA](https://www.foodbusinessmea.com/kenyas-kirinyaga-coffee-farmers-earn-record-us57-2m-as-payouts-hit-us1-21-per-kg/), 2025/26 season | Kirinyaga cherry payouts KES 104–157/kg, average KES 139/kg | VERIFIED (secondary) | One county, one season | Coops have seasonal cash at payout time; a per-season fee aligns with that cycle |
| E-05 | Can women afford a capable phone? | [GSMA Mobile Gender Gap Report 2025](https://www.gsma.com/wp-content/uploads/2025/12/The-Mobile-Gender-Gap-Report-2025.pdf) | Entry handset = 24% of a woman's monthly income in LMICs (12% for men); rural women least included; Kenya's ownership gap is smaller than its income predicts (M-Pesa) | VERIFIED (secondary summary) | LMIC average, not Kenya-specific for handset cost | Do not require Noor to buy a phone; run on the household phone (daughter's) |
| E-06 | Which phones can run the stack? | [naijatechguide](https://www.naijatechguide.com/best-android-phones-under-15000-ksh-in-kenya.html), [money254](https://www.money254.co.ke/post/all-you-need-to-know-about-the-new-m-kopa-x20-smartphone-mk3), [techtrendske](https://techtrendske.co.ke/2025/08/26/device-financing-in-kenya-smartphone-prices/) | Cheapest Androids ~KES 8,700–10,000 with 2–3 GB RAM; 4 GB models ~KES 15,000–20,000; M-KOPA X20 ~KES 4,000 deposit + KES 92–95/day | VERIFIED (secondary) | Prices move fast | Our models need about 4 GB RAM, so 2 GB phones are out. **Biggest adoption risk.** On-phone RAM/latency must come from Codex Mobile (Mac numbers are not phone numbers) |
| E-07 | Who can fund a pilot? | [World Bank press release, 2022-03-29](https://www.worldbank.org/en/news/press-release/2022/03/29/kenya-secures-250-million-to-help-500-000-smallholder-farmers-enhance-value-addition-and-access-markets) | NAVCDP: US$250M IDA + US$25M GoK, 500,000 farmers, 26 counties, coffee among 9 value chains, includes digital agriculture | VERIFIED (secondary) | Agricultural, not tourism; procurement rules and remaining budget UNKNOWN (a mid-term review ToR exists, 2025) | Pitch as coffee-farmer income diversification, not as tourism software |
| E-08 | Running cost of connectivity | [TechCabal](https://techcabal.com/?p=165500), [Safaricom](https://www.safaricom.co.ke/media-center-landing/press-releases/safaricom-announces-new-all-in-one-bundles-that-offer-both-calls-and-data) | Safaricom 1 GB/30 days KES 250; 1 GB/24 h KES 100 | VERIFIED (secondary) | Exact current menu varies | Since inference is local, only messages use data: well under 1 GB/month. Cloud AI cost: zero |
| E-09 | Model pack size | `data/model-manifest.json`, 2026-10-04 | Phone: Gemma 4 E4B Q4_0 about 4.6 GB (fallback E2B about 2.2 GB). Speech (faster-whisper, Chatterbox) runs on the hub PC, not the phone. (Superseded: the W1 prototype pack was Whisper + Qwen3 0.6B + MMS-TTS = 1.36 GB, MEASURED on disk) | VERIFIED (manifest) | E4B is over the brief's 2 GB side-load target | Far too big for a mobile bundle (about 4.6× the monthly 1 GB at E-08 prices); side-load at the coop by USB is the only realistic path |
| E-13 | Running cost of the hub | Architecture in README, 2026-10-04 | One always-on PC at the tourism office or coop runs the hub, the voice agent and its models; real SMS and calls go through Twilio / a LiveKit SIP trunk | PROPOSED | PC price, power, and Kenyan SMS/voice rates are UNKNOWN (not yet sourced) | Shared by all farms of one coop, so the cost per farm falls with the number of hosting farms; source real rates before quoting a price |
| E-10 | Payment rails | [TechCabal M-Pesa 2025](https://techcabal.com/2025/10/13/m-pesa-charges-in-kenya-2025/) | Sending KES 501–1,000 costs KES 13 | VERIFIED (secondary) | Tariffs change | Deposits are paid by M-Pesa; Sauti only records owner-confirmed payments, never moves money |
| E-11 | Demand | [Citizen Digital / TRI 2025 report](https://citizen.digital/article/kenya-records-79-million-tourists-in-2025-as-sector-earns-ksh05-trillion-n380167) | 2.65M international arrivals in 2025 (+7.2%); Europe 25%, US 304k | VERIFIED (secondary) | Share visiting rural farms is UNKNOWN | English/German/French demand is real, so translation is a core need |
| E-12 | What do tour operators pay for software? | [Bókun pricing](https://www.bokun.io/tour-and-activity-booking-system-pricing) | US$49–499/month + 1–1.5% per booking | VERIFIED (vendor page) | Built for professional operators | Irrelevant price anchor for Noor, which confirms that a B2B2C coop model is needed |

## 3. Unit economics for one farm (PROPOSED, demo assumptions)

| Item | Value | Basis |
|---|---|---|
| Visitors per month | 6–7 | Challenge brief (Noor) |
| Direct price per visitor | KES 2,000 | Demo assumption, UNKNOWN in reality |
| Gross tour revenue per month | ~KES 13,000 | 6.5 × 2,000 |
| Kept on one direct booking vs OTA | KES 400–600 | 20–30% of 2,000 (E-02) |
| Sauti data cost per month | < KES 250 | E-08, messages only |
| Cloud AI cost | 0 | Local inference (phone and hub) |
| Hub PC + SMS/voice provider | UNKNOWN, shared across the coop's farms | E-13 |

**Pricing hypothesis (PROPOSED, needs Cosme sign-off):** the coop pays **KES 1,500 per hosting farm per season (about 6 months)**, i.e. ~KES 250/month. That is less than what Noor keeps from a single booking moved from an OTA to direct. The farmer pays nothing. Validate in the pilot: if Sauti converts even one extra direct booking per month, it pays for itself.

## 4. Distribution plan (PROPOSED)

1. **Pick 1 cooperative** in a county tourists already reach (Nyeri/Kirinyaga/Kiambu), with **≥10 member farms that already host visitors** (UNKNOWN; to be found through the coop).
2. **Side-load at the factory**: a coop field officer installs the app and model pack by USB during the cherry delivery or payout visit. No download needed.
3. **One hub per coop or tourism office**: an always-on PC answers tourist SMS and calls for all member farms and sends Noor her approvals by SMS, so she can say yes or no from her basic phone (E-13).
4. **Weekend onboarding with the daughter** (she owns the smartphone): W1 farm-sheet setup in one call, read back in Swahili.
5. **Field officer = support line**, reached by voice call, not by app chat.

## 5. Paid pilot proposal (PROPOSED)

- 1 coop, 10–20 hosting farms, 3 months, funded by the coop or a NAVCDP-type grant.
- Measured outcomes:
  - median time to answer a tourist;
  - share of direct vs OTA bookings;
  - messages left unanswered;
  - proposals Noor rejected or edited (a safety signal);
  - double bookings (target: 0).
- Success = a positive answer from the coop board to "would you pay KES 1,500/farm/season?" + ≥1 extra direct booking/farm/month.

## 6. Open risks and unknowns

- **Phone RAM**: the household phone may have <4 GB and be unable to run the models (E-06). Measured so far only on iPhones (15 Pro, 17 Pro Max); a low-cost Android is UNMEASURED.
- **Weekend-only smartphone**: replies can take days, so the conversion uplift may be smaller than hoped.
- **Licenses**: resolved. NLLB-200, MMS-TTS and fastText language ID (CC BY-NC) are excluded; the product uses Gemma 4 (Apache-2.0), faster-whisper and Chatterbox (MIT).
- **Model size**: Gemma 4 E4B (about 4.6 GB) is over the 2 GB target and needs a phone with room for it; E2B (about 2.2 GB) is the fallback (E-09).
- **Nobody has validated Swahili natively** (Experience packet). A paid pilot cannot start before native review.
- **Coop willingness to pay**: UNKNOWN; this is the #1 question for the pilot.

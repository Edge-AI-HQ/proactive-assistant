"""Synthetic phase1 fixture: persona "Alice Tan".

A deliberately concrete persona so the card generator has enough grounded
surface area to produce specific, time-bounded, useful cards. The shape
matches what `build_generation_context` returns in production (same top-level
keys the generator's `_build_source_index` / planner read), so feeding this
into `run_generator` exercises the real pipeline end to end with zero web /
DB dependency — only LiteLLM.

All timestamps are derived from `datetime.now(UTC)` at call time, so the
fixture stays "today-relevant" whenever the smoke test runs.

Persona: Alice Tan (艾莉丝) — 29yo product manager, fintech, New York.
Why this persona: a single launch-crunch knowledge worker with money,
family-abroad, health, growth and life threads all live at once gives every
goal basket (work / wealth / family / health / growth / life) something to
ground on.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

PERSONA_NAME = "Alice Tan (29yo product manager in New York, fintech)"

PERSONA_EVALUATOR_BRIEF = """You are roleplaying the persona Alice Tan — a 29yo
senior product manager at a Series-B fintech (Northstar Pay) in New York,
hybrid (in-office Tue–Thu). Canadian citizen from Toronto on a US TN visa.

Hard background:
- Partner Daniel (31, software eng). No kids. One dog, Mochi (3yo corgi).
- Mom (Grace, 61) in Toronto, knee replacement surgery scheduled mid next
  month; Alice wants to fly up to help for a week.
- Comp: $172k base + RSUs vesting quarterly. Next vest ~$22k.
- $38k idle cash in a Chase checking account earning ~0%.
- Owns ETH since 2021 (small), maxes 401k, no other big investments.
- Leading the "Instant Payouts" GA launch — the company's biggest H1 bet.
- Pushing for promotion to Group PM this cycle; manager is Priya.
- Training (loosely) for a 10k in November; long-run streak broke 2 weeks ago.
- Sleep has drifted to ~01:30 during the launch crunch.

Persona preferences:
- Reads in English. Hates "you may like" / "I noticed" titles — wants a
  number, date or fact up front.
- Wants concrete dollar amounts, not generic advice.
- Will not use meditation / journaling / mindfulness apps.
- When family and work collide on the same day, family wins.
- No early-morning workout suggestions — she's a night owl during crunch.

Persona judgement style:
- Senior IC/manager. Skeptical of fluff. Very sensitive to wasted time.
- Clicks only if a card saves her real thinking, money, or social capital.
- A card must be readable in 5 seconds at the end of a long day.
"""


def _iso(dt: datetime) -> str:
    return dt.isoformat()


def build_alice_phase1() -> dict[str, Any]:
    now = datetime.now(UTC)

    def at(days: float = 0, hours: float = 0) -> str:
        return _iso(now + timedelta(days=days, hours=hours))

    profile = {
        "id": "primary",
        "display_name": "Alice Tan",
        "summary": (
            "Alice Tan, 29, female. Senior Product Manager at Northstar Pay "
            "(US Series-B fintech, NYC HQ, ~140 people). Lives in Brooklyn, "
            "hybrid in-office Tue–Thu. Canadian citizen from Toronto, in the US "
            "on a TN visa (renews yearly). Partner Daniel (software engineer), "
            "no kids, one corgi (Mochi). Leads the flagship 'Instant Payouts' "
            "launch and is pushing for promotion to Group PM this cycle. Comp is "
            "USD base + quarterly RSU vests; keeps idle cash in Chase checking and "
            "maxes her 401k. Holds a small ETH position since 2021. Mom Grace (61) "
            "lives in Toronto and has knee-replacement surgery next month. Trains "
            "loosely for a November 10k. Reads product / fintech newsletters and a "
            "few AI blogs; prefers concrete numbers over generic advice."
        ),
        "facts": {
            "role": "Senior Product Manager",
            "employer": "Northstar Pay (US fintech, Series B, NYC HQ, ~140 people)",
            "team": "Payments / Payouts",
            "location": "Brooklyn, NY (hybrid, in-office Tue–Thu)",
            "citizenship": "Canada (TN visa in US)",
            "age": 29,
            "manager": "Priya Nair (VP Product)",
            "family": {
                "partner": "Daniel (31, software engineer)",
                "dog": "Mochi (3yo corgi)",
                "mother": "Grace (61, Toronto), knee replacement next month",
            },
            "comp": {
                "base_usd": 172000,
                "rsu_quarterly_usd": 22000,
                "next_vest": "quarterly on the 15th",
                "cash_idle_usd": 38000,
                "retirement": "401k maxed",
                "crypto": "ETH (small, since 2021)",
            },
            "goals": [
                "Ship Instant Payouts GA without a Sev-1",
                "Get promoted to Group PM this cycle",
                "Be in Toronto for Mom's surgery + recovery week",
                "Rebuild the 10k training base before November",
            ],
        },
    }

    memory = [
        {
            "id": "mem_001",
            "text": "Alice's Northstar Pay RSUs vest quarterly on the 15th; next vest ≈ $22,000 USD pre-tax, sell-to-cover.",
            "kind": "fact",
            "salience": 0.9,
            "created_at": at(-40),
        },
        {
            "id": "mem_002",
            "text": "Instant Payouts GA is the company's top H1 bet; Alice is DRI. Exec/board demo gates the go/no-go.",
            "kind": "fact",
            "salience": 0.95,
            "created_at": at(-30),
        },
        {
            "id": "mem_003",
            "text": "Alice is up for promotion to Group PM this cycle. Priya asked for a one-page impact doc with shipped-metric evidence.",
            "kind": "fact",
            "salience": 0.88,
            "created_at": at(-12),
        },
        {
            "id": "mem_004",
            "text": "Mom (Grace, Toronto) has a knee replacement scheduled; Alice promised to come up for the surgery and first recovery week.",
            "kind": "fact",
            "salience": 0.9,
            "created_at": at(-9),
        },
        {
            "id": "mem_005",
            "text": "Alice has ~$38k sitting in a Chase checking account at ~0% APY since the bonus landed in March.",
            "kind": "fact",
            "salience": 0.8,
            "created_at": at(-20),
        },
        {
            "id": "mem_006",
            "text": "Alice and Daniel booked a Lisbon anniversary trip; the dates are set but flights are NOT booked yet.",
            "kind": "fact",
            "salience": 0.78,
            "created_at": at(-15),
        },
        {
            "id": "mem_007",
            "text": "Alice's TN visa renews yearly; HR flagged the supporting letter needs re-issuing before her next border entry.",
            "kind": "fact",
            "salience": 0.72,
            "created_at": at(-7),
        },
        {
            "id": "mem_008",
            "text": "Alice's 10k training plan (Nov race) broke two weeks ago when the launch crunch started; longest recent run is 4km.",
            "kind": "fact",
            "salience": 0.6,
            "created_at": at(-5),
        },
        {
            "id": "mem_009",
            "text": "Alice will not use meditation / journaling apps — dismissed two such cards before.",
            "kind": "preference",
            "salience": 0.7,
            "created_at": at(-6),
        },
        {
            "id": "mem_010",
            "text": "Mochi (corgi) is due for the annual rabies + DHPP booster; the vet sent a reminder.",
            "kind": "fact",
            "salience": 0.55,
            "created_at": at(-4),
        },
        {
            "id": "mem_011",
            "text": "Alice was invited to give a 20-min talk at ProductCon on payments UX; the abstract deadline is near.",
            "kind": "fact",
            "salience": 0.7,
            "created_at": at(-8),
        },
        {
            "id": "mem_012",
            "text": "Brooklyn apartment lease renewal offer arrived with a rent increase; decision deadline is coming up.",
            "kind": "fact",
            "salience": 0.75,
            "created_at": at(-10),
        },
    ]

    signals = [
        {
            "id": "sig_launch_countdown",
            "source": "project_tracker",
            "title": "Instant Payouts GA ~9 days out; 3 P1 bugs open",
            "summary": "GA target is in ~9 days. Jira shows 3 open P1s (idempotency on retried payouts, webhook ordering, KYC edge case). Burn-down is behind by ~2 days.",
            "occurred_at": at(0, -3),
            "salience": 0.95,
            "payload": {"open_p1": 3, "days_to_ga": 9},
        },
        {
            "id": "sig_board_demo",
            "source": "calendar_engine",
            "title": "Exec/board go-no-go demo in 3 days",
            "summary": "The board go/no-go demo for Instant Payouts is in 3 days; deck + live demo script not finalized.",
            "occurred_at": at(0, -5),
            "salience": 0.92,
            "payload": {"days_out": 3},
        },
        {
            "id": "sig_ab_result",
            "source": "experiment_platform",
            "title": "Payout-speed A/B hit significance: +18% activation",
            "summary": "The 'instant vs next-day' onboarding A/B reached significance: instant variant +18% activation, -6% support tickets. Decision to ship-all needed before GA freeze.",
            "occurred_at": at(-1),
            "salience": 0.86,
            "payload": {"lift_activation": 0.18, "ticket_delta": -0.06},
        },
        {
            "id": "sig_idle_cash",
            "source": "finance_signal",
            "title": "$38k idle in checking at ~0% for ~80 days",
            "summary": "Chase checking has held ≈$38,000 idle since March. At 4.9% a money-market/HYSA would earn ≈$155/mo. Tax-season cash buffer already separate.",
            "occurred_at": at(-2),
            "salience": 0.8,
            "payload": {"idle_usd": 38000, "hysa_apy": 0.049, "monthly_yield": 155},
        },
        {
            "id": "sig_mom_surgery",
            "source": "personal_calendar",
            "title": "Mom's knee surgery date confirmed (mid next month)",
            "summary": "Grace's orthopedic surgery is confirmed for mid next month in Toronto. Alice has not yet requested leave or booked flights; recovery help window is ~7 days.",
            "occurred_at": at(-1, -2),
            "salience": 0.9,
            "payload": {"city": "Toronto"},
        },
        {
            "id": "sig_lisbon_flights",
            "source": "travel_signal",
            "title": "Lisbon anniversary dates set, flights still unbooked",
            "summary": "Trip dates are locked in ~3 weeks. EWR→LIS nonstop fares have risen ~22% in 10 days and midweek seats are thinning. Daniel is waiting on Alice to pick the outbound.",
            "occurred_at": at(-2, -6),
            "salience": 0.72,
            "payload": {"fare_trend_pct": 0.22},
        },
        {
            "id": "sig_sleep_drift",
            "source": "wearable",
            "title": "Bedtime drifted to ~01:30, 6 nights running",
            "summary": "Sleep tracker shows bedtime past 01:30 for 6 consecutive nights since the launch crunch; average sleep 5h 40m, down from 7h baseline.",
            "occurred_at": at(0, -7),
            "salience": 0.64,
            "payload": {"avg_sleep_h": 5.7},
        },
        {
            "id": "sig_promo_doc",
            "source": "hr_signal",
            "title": "Group PM promo packet impact doc requested by Priya",
            "summary": "Priya asked for a one-page impact doc (shipped metrics, scope, cross-team leadership) to anchor the Group PM case at the upcoming calibration.",
            "occurred_at": at(-3),
            "salience": 0.8,
            "payload": {},
        },
        {
            "id": "sig_visa_letter",
            "source": "hr_signal",
            "title": "TN visa support letter needs re-issue before border entry",
            "summary": "HR flagged Alice's TN support letter is stale; it must be re-issued before her next US border re-entry (the Toronto trip).",
            "occurred_at": at(-4),
            "salience": 0.7,
            "payload": {},
        },
        {
            "id": "sig_productcon",
            "source": "calendar_engine",
            "title": "ProductCon talk abstract due soon",
            "summary": "Alice's invited 20-min ProductCon talk needs a title + 150-word abstract submitted to organizers; deadline is in a few days.",
            "occurred_at": at(-2, -1),
            "salience": 0.66,
            "payload": {},
        },
        {
            "id": "sig_lease",
            "source": "housing_signal",
            "title": "Brooklyn lease renewal: +9.5% rent, decision deadline near",
            "summary": "Renewal offer is +9.5% ($310/mo). Two comparable units nearby list ~4% cheaper. Landlord wants a decision in ~10 days or the unit goes to market.",
            "occurred_at": at(-3, -4),
            "salience": 0.74,
            "payload": {"increase_pct": 0.095, "monthly_delta": 310},
        },
        {
            "id": "sig_mochi_vet",
            "source": "personal_signal",
            "title": "Mochi's annual vaccine booster overdue reminder",
            "summary": "Vet reminder: Mochi's rabies + DHPP booster is due; clinic has limited weekend slots over the next two weeks.",
            "occurred_at": at(-4, -2),
            "salience": 0.5,
            "payload": {},
        },
    ]

    gmail = [
        {
            "id": "gmail_msg_001",
            "subject": "[Northstar] Board demo dry-run — please confirm slot",
            "from": "priya.nair@northstarpay.com",
            "snippet": "Alice — can you lock a dry-run before the board demo? We can't wing the live payout flow. Also need the rollback story on one slide.",
            "received_at": at(0, -4),
            "salience": 0.9,
        },
        {
            "id": "gmail_msg_002",
            "subject": "Experiment readout: instant-payout onboarding (significant)",
            "from": "data-platform@northstarpay.com",
            "snippet": "The instant variant reached significance: +18.2% activation, -6.1% tickets. Recommend ship-all; needs PM sign-off before the GA code freeze.",
            "received_at": at(-1, -1),
            "salience": 0.84,
        },
        {
            "id": "gmail_msg_003",
            "subject": "Mom — surgery date + what I need from you",
            "from": "grace.tan@gmail.com",
            "snippet": "Hi sweetheart, the surgeon confirmed the date. Can you come up for the week after? I'll need help getting around for the first few days.",
            "received_at": at(-1, -2),
            "salience": 0.88,
        },
        {
            "id": "gmail_msg_004",
            "subject": "Chase: your checking balance summary",
            "from": "no-reply@chase.com",
            "snippet": "Your checking balance is $38,142.send money, pay bills... (idle balance unchanged for 80+ days)",
            "received_at": at(-2),
            "salience": 0.6,
        },
        {
            "id": "gmail_msg_005",
            "subject": "Re: Lisbon — which flights?? prices going up",
            "from": "daniel@gmail.com",
            "snippet": "Babe the EWR-LIS nonstop jumped again. If we don't book this week we're stuck with a connection in Lisbon both ways. Pick a date and I'll buy tonight.",
            "received_at": at(-2, -5),
            "salience": 0.72,
        },
        {
            "id": "gmail_msg_006",
            "subject": "[HR] Action needed: TN support letter re-issue",
            "from": "people-ops@northstarpay.com",
            "snippet": "Your TN support letter on file is older than 12 months. We must re-issue before any US re-entry. Reply with your travel dates and we'll turn it around in 3 business days.",
            "received_at": at(-4),
            "salience": 0.7,
        },
        {
            "id": "gmail_msg_007",
            "subject": "ProductCon: we'd love your session title + abstract",
            "from": "speakers@productcon.io",
            "snippet": "Thrilled to have you! Please send your final talk title and a 150-word abstract by the speaker deadline so we can publish the agenda.",
            "received_at": at(-2, -1),
            "salience": 0.64,
        },
        {
            "id": "gmail_msg_008",
            "subject": "Lease renewal offer — 2BR, Park Slope",
            "from": "leasing@brooklynstone.com",
            "snippet": "Your renewal offer: $3,580/mo (was $3,270), 12-month term. Please sign within 10 days to hold the unit at this rate.",
            "received_at": at(-3, -4),
            "salience": 0.7,
        },
    ]

    gcal = [
        {
            "id": "gcal_evt_board_demo",
            "title": "Board go/no-go demo — Instant Payouts",
            "start": at(3, -7),
            "end": at(3, -6),
            "salience": 0.95,
        },
        {
            "id": "gcal_evt_ga_freeze",
            "title": "Instant Payouts — GA code freeze",
            "start": at(7),
            "end": at(7, 1),
            "salience": 0.9,
        },
        {
            "id": "gcal_evt_ga_launch",
            "title": "Instant Payouts — GA launch",
            "start": at(9),
            "end": at(9, 1),
            "salience": 0.93,
        },
        {
            "id": "gcal_evt_priya_1on1",
            "title": "1:1 with Priya (promo packet review)",
            "start": at(2, -8),
            "end": at(2, -7.5),
            "salience": 0.78,
        },
        {
            "id": "gcal_evt_vet",
            "title": "Mochi — vet (rabies + DHPP booster)",
            "start": at(5, -3),
            "end": at(5, -2.5),
            "salience": 0.5,
        },
    ]

    cards_recent = [
        {
            "id": "card_old_001",
            "intentKey": "chase-idle-cash-hysa",
            "title": "Move $38k idle Chase cash to a 4.9% money market",
            "goalBasket": "wealth",
            "whyNow": "Idle since March at ~0%.",
            "summary": "One move earns ≈$155/mo without touching the tax buffer.",
            "latestOutcome": "snoozed",
            "outcomeAt": at(-2),
            "sources": ["gmail message id=gmail_msg_004, subject=Chase balance summary"],
        },
        {
            "id": "card_old_002",
            "intentKey": "lisbon-flight-book",
            "title": "Book EWR→LIS before fares climb again",
            "goalBasket": "life",
            "whyNow": "Fares up 22% in 10 days.",
            "summary": "Pick the outbound; Daniel buys tonight.",
            "latestOutcome": "confirmed",
            "outcomeAt": at(-1),
            "sources": ["gmail message id=gmail_msg_005, subject=Re: Lisbon"],
        },
        {
            "id": "card_old_003",
            "intentKey": "meditation-app-trial",
            "title": "Try a 5-min guided breathing app tonight",
            "goalBasket": "health",
            "whyNow": "Sleep is short.",
            "summary": "A breathing app might help you wind down.",
            "latestOutcome": "dismissed",
            "outcomeAt": at(-3),
            "sources": ["signal id=sig_sleep_drift"],
        },
    ]

    feedback = [
        {
            "cardId": "card_old_003",
            "intentKey": "meditation-app-trial",
            "outcome": "dismissed",
            "text": "Don't push meditation/journaling/mindfulness apps — I won't use them.",
            "createdAt": at(-3),
        },
        {
            "cardId": "card_old_002",
            "intentKey": "lisbon-flight-book",
            "outcome": "confirmed",
            "text": "Yes — this is exactly the nudge I needed.",
            "createdAt": at(-1),
        },
        {
            "cardId": "card_old_001",
            "intentKey": "chase-idle-cash-hysa",
            "outcome": "snoozed",
            "text": "Good idea but remind me after the launch.",
            "createdAt": at(-2),
        },
    ]

    world = [
        {
            "id": "world_001",
            "title": "US HYSA / money-market yields holding near 4.9% APY",
            "summary": "Top money-market funds and high-yield savings continue to quote ~4.8–5.0% APY this month.",
            "occurred_at": at(-1),
            "salience": 0.5,
        },
        {
            "id": "world_002",
            "title": "Transatlantic summer fares trending up week over week",
            "summary": "US→Europe nonstop economy fares are rising into peak season; analysts flag booking windows narrowing.",
            "occurred_at": at(-2),
            "salience": 0.45,
        },
        {
            "id": "world_003",
            "title": "ProductCon agenda publishing this week",
            "summary": "Conference organizers are finalizing the published agenda; confirmed speakers are being listed.",
            "occurred_at": at(-2),
            "salience": 0.4,
        },
    ]

    preferences = [
        {
            "id": "pref_lang_en",
            "statement": "Generate cards in English.",
            "scope": "output_language",
            "polarity": "positive",
            "durability": "persistent",
            "expires_at": None,
            "weight": 0.9,
        },
        {
            "id": "pref_no_mindfulness",
            "statement": "Never suggest meditation, journaling, or mindfulness apps.",
            "scope": "health",
            "polarity": "negative",
            "durability": "persistent",
            "expires_at": None,
            "weight": 0.95,
        },
        {
            "id": "pref_concrete_money",
            "statement": "Prefer concrete dollar amounts and dates over generic advice.",
            "scope": "global",
            "polarity": "positive",
            "durability": "persistent",
            "expires_at": None,
            "weight": 0.85,
        },
        {
            "id": "pref_title_style",
            "statement": "Hate 'you may like' / 'I noticed' titles; lead with a number, date, or fact.",
            "scope": "title",
            "polarity": "negative",
            "durability": "persistent",
            "expires_at": None,
            "weight": 0.8,
        },
        {
            "id": "pref_family_first",
            "statement": "When family and work collide on the same day, prioritize family.",
            "scope": "global",
            "polarity": "positive",
            "durability": "persistent",
            "expires_at": None,
            "weight": 0.85,
        },
        {
            "id": "pref_no_morning_workout",
            "statement": "No early-morning workout suggestions during launch crunch.",
            "scope": "health",
            "polarity": "negative",
            "durability": "temporary",
            "expires_at": at(20),
            "weight": 0.7,
        },
    ]

    connections = [
        {"toolkit": "gmail", "status": "connected"},
        {"toolkit": "google_calendar", "status": "connected"},
    ]

    connected_raw = {
        "gmail/messages": [
            {
                "id": m["id"],
                "subject": m["subject"],
                "from": m["from"],
                "snippet": m["snippet"],
                "received_at": m["received_at"],
            }
            for m in gmail
        ],
        "gcal/events": [
            {"id": e["id"], "title": e["title"], "start": e["start"], "end": e["end"]} for e in gcal
        ],
    }

    return {
        "context_window": {"since": at(-2), "until": at(0), "reason": "synthetic_test"},
        "profile": profile,
        "memory": memory,
        "signals": signals,
        "gmail": gmail,
        "gcal": gcal,
        "cards_recent": cards_recent,
        "feedback": feedback,
        "world": world,
        "preferences": preferences,
        "connections": connections,
        "connected_raw": connected_raw,
        "ambient_signal_details": [],
        "context_stats": {
            "synthetic": True,
            "signals": {"count": len(signals)},
            "memory": {"count": len(memory)},
            "gmail": {"count": len(gmail)},
            "gcal": {"count": len(gcal)},
            "feedback": {"count": len(feedback)},
            "world": {"count": len(world)},
            "preferences": {"count": len(preferences)},
        },
    }
